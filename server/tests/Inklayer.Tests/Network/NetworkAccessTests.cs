using System.Net;
using System.Net.Http.Json;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Inklayer.Tests.Network;

/// <summary>
/// The allow list is instance-wide, so these tests get their own server and database. They run on their own, after the
/// other tests: servers starting at the same time race to set up the shared Serilog logger.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class NetworkTestGroup : ICollectionFixture<InklayerApiFactory>
{
    public const string Name = "network";
}

[Collection(NetworkTestGroup.Name)]
public sealed class NetworkAccessTests(InklayerApiFactory factory)
{
    private const string Vpn = "10.8.0.5";
    private const string Home = "198.51.100.7";

    private sealed record NetworkDto(List<string> AllowedNetworks, string Source, bool RestrictionDisabled, string? YourAddress, bool YourAddressAllowed);

    private static HttpClient From(HttpClient client, string address)
    {
        client.DefaultRequestHeaders.Remove(InklayerApiFactory.ClientIpHeader);
        client.DefaultRequestHeaders.Add(InklayerApiFactory.ClientIpHeader, address);
        return client;
    }

    private static async Task<NetworkDto> SaveAsync(HttpClient admin, params string[] networks)
    {
        using var response = await admin.PutJsonAsync("/api/admin/network", new { allowedNetworks = networks });
        return await response.ReadAsync<NetworkDto>();
    }

    [Fact]
    public async Task Admins_limit_the_server_to_the_vpn()
    {
        var admin = From(await factory.SignInAsAdminAsync(), Vpn);
        var (user, _) = await Scenario.AddMemberAsync(factory, admin, (await Scenario.CreateOrganizationAsync(admin)).Id, "Commenter");
        try
        {
            using (var before = await admin.GetAsync(new Uri("/api/admin/network", UriKind.Relative)))
            {
                var network = await before.ReadAsync<NetworkDto>();
                Assert.Empty(network.AllowedNetworks); // "None", or "Admin" if another test saved an empty list first
                Assert.Equal((Vpn, true), (network.YourAddress, network.YourAddressAllowed));
            }

            var saved = await SaveAsync(admin, "10.8.0.0/16");
            Assert.Equal(["10.8.0.0/16"], saved.AllowedNetworks);
            Assert.Equal("Admin", saved.Source);

            using (var refused = await From(user, Home).GetAsync(new Uri("/api/me", UriKind.Relative)))
            {
                Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
                Assert.Equal("application/problem+json", refused.Content.Headers.ContentType?.MediaType);
                Assert.Contains(Home, await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
            }

            using (var page = await user.GetAsync(new Uri("/orgs/x", UriKind.Relative)))
            {
                Assert.Equal(HttpStatusCode.Forbidden, page.StatusCode);
                Assert.Equal("text/html", page.Content.Headers.ContentType?.MediaType);
            }

            await user.GetAsync(new Uri("/health/live", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
            await From(user, "10.8.44.1").GetAsync(new Uri("/api/me", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
        }
        finally
        {
            await SaveAsync(admin);
        }

        await From(user, Home).GetAsync(new Uri("/api/me", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
        admin.Dispose();
        user.Dispose();
    }

    [Fact]
    public async Task A_list_that_would_lock_out_the_admin_saving_it_is_refused()
    {
        var admin = From(await factory.SignInAsAdminAsync(), Vpn);

        await admin.PutJsonAsync("/api/admin/network", new { allowedNetworks = new[] { "10.9.0.0/16" } }).ExpectAsync(HttpStatusCode.Conflict);
        await admin.PutJsonAsync("/api/admin/network", new { allowedNetworks = new[] { "10.8.0.0/16", "not-an-ip" } }).ExpectAsync(HttpStatusCode.BadRequest);

        using var response = await admin.GetAsync(new Uri("/api/admin/network", UriKind.Relative));
        Assert.Empty((await response.ReadAsync<NetworkDto>()).AllowedNetworks);
        admin.Dispose();
    }

    [Fact]
    public async Task Only_instance_administrators_see_or_change_the_list()
    {
        var admin = await factory.SignInAsAdminAsync();
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, (await Scenario.CreateOrganizationAsync(admin)).Id, "Owner");
        var user = From(member, Vpn);

        await user.GetAsync(new Uri("/api/admin/network", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await user.PutJsonAsync("/api/admin/network", new { allowedNetworks = new[] { "10.8.0.0/16" } }).ExpectAsync(HttpStatusCode.Forbidden);
        user.Dispose();
        admin.Dispose();
    }

    [Fact]
    public async Task The_configured_list_applies_until_an_admin_saves_one()
    {
        await using var fresh = new InklayerApiFactory();
        await using var configured = fresh.WithWebHostBuilder(b => b.UseSetting("Inklayer:Network:AllowedNetworks", "10.8.0.0/16, 203.0.113.7"));
        var admin = From(await SignInAsAdminAsync(configured), Vpn);

        using (var response = await admin.GetAsync(new Uri("/api/admin/network", UriKind.Relative)))
        {
            var network = await response.ReadAsync<NetworkDto>();
            Assert.Equal(["10.8.0.0/16", "203.0.113.7/32"], network.AllowedNetworks);
            Assert.Equal("Config", network.Source);
        }

        await From(admin, Home).GetAsync(new Uri("/api/me", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        From(admin, Vpn);
        Assert.Equal("Admin", (await SaveAsync(admin, "10.8.0.0/16", Home)).Source);
        await From(admin, Home).GetAsync(new Uri("/api/me", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
        admin.Dispose();
    }

    [Fact]
    public async Task The_restriction_can_be_switched_off_in_configuration_for_recovery()
    {
        var admin = From(await factory.SignInAsAdminAsync(), Vpn);
        try
        {
            await SaveAsync(admin, "10.8.0.0/16");
            await using var recovery = factory.WithWebHostBuilder(b => b.UseSetting("Inklayer:Network:RestrictionDisabled", "true"));
            using var client = BrowserClient(recovery);
            client.DefaultRequestHeaders.Add(InklayerApiFactory.ClientIpHeader, Home);
            await client.GetAsync(new Uri("/health/live", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
            using var page = await client.GetAsync(new Uri("/api/me", UriKind.Relative));
            Assert.Equal(HttpStatusCode.Unauthorized, page.StatusCode);
        }
        finally
        {
            await SaveAsync(From(admin, Vpn));
        }

        admin.Dispose();
    }

    /// <summary><see cref="InklayerApiFactory.CreateBrowserClient"/> for a factory derived with <c>WithWebHostBuilder</c>.</summary>
    private static HttpClient BrowserClient(WebApplicationFactory<Program> derived)
    {
        var client = derived.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });
        client.DefaultRequestHeaders.Add(Inklayer.Api.Auth.CsrfHeader.Name, "1");
        return client;
    }

    /// <summary><see cref="InklayerApiFactory.SignInAsAdminAsync"/> for a factory derived with <c>WithWebHostBuilder</c>.</summary>
    private static async Task<HttpClient> SignInAsAdminAsync(WebApplicationFactory<Program> derived)
    {
        var client = BrowserClient(derived);
        using var response = await client.PostAsJsonAsync(InklayerApiFactory.TestLoginPath,
            Identities.Consumer(InklayerApiFactory.BootstrapAdminEmail, subject: "bootstrap-admin-subject"));
        response.EnsureSuccessStatusCode();
        return client;
    }
}
