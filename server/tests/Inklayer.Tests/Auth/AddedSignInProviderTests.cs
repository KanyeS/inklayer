using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Inklayer.Api.Auth;
using Inklayer.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Auth;

/// <summary>Instance administrators add a second sign-in provider on the Admin page, without touching the server's configuration.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class AddedSignInProviderTests(InklayerApiFactory factory)
{
    private const string Path = "/api/admin/sign-in-providers";

    [Fact]
    public async Task An_added_provider_works_straight_away_end_to_end_and_goes_when_removed()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var id = UniqueId();
        try
        {
            using var added = await admin.PostAsJsonAsync(Path, Request(id));
            Assert.Equal(HttpStatusCode.OK, added.StatusCode);
            var list = await added.Content.ReadFromJsonAsync<JsonElement>();
            var provider = list.GetProperty("providers").EnumerateArray().Single(p => p.GetProperty("id").GetString() == id);
            Assert.Equal("Admin", provider.GetProperty("source").GetString());
            Assert.True(provider.GetProperty("hasClientSecret").GetBoolean());
            Assert.Equal($"http://localhost/auth/callback/{id}", provider.GetProperty("redirectUri").GetString());
            Assert.DoesNotContain("added-secret", list.GetRawText(), StringComparison.Ordinal);

            using var browser = factory.CreateBrowserClient();
            var providers = await browser.GetFromJsonAsync<List<SignInProvider>>(new Uri("/auth/providers", UriKind.Relative));
            Assert.Contains(new SignInProvider(id, "Second SSO"), providers!);

            // Someone from the provider's verified domain is invited, then signs in through it.
            var org = await Scenario.CreateOrganizationAsync(admin);
            var email = Identities.UniqueEmail(domain: "second.test");
            await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email, role = "Commenter" }).ExpectAsync(HttpStatusCode.Created);
            using var https = factory.CreateBrowserClient(https: true);
            using var callback = await SignInThroughAsync(https, id, new() { ["sub"] = Guid.NewGuid().ToString("N"), ["email"] = email, ["name"] = "Grace" });
            Assert.Equal("/", callback.Headers.Location!.OriginalString);
            using var me = await https.GetAsync(new Uri("/api/me", UriKind.Relative));
            Assert.Equal(email, (await me.ReadAsync<MeDto>()).Email);

            await admin.DeleteAsync(new Uri($"{Path}/{id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
            using var gone = await browser.GetAsync(new Uri($"/auth/login?provider={id}", UriKind.Relative));
            Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
        }
        finally
        {
            await admin.DeleteAsync(new Uri($"{Path}/{id}", UriKind.Relative));
        }
    }

    [Fact]
    public async Task Changing_a_provider_keeps_its_secret_unless_a_new_one_is_given()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var id = UniqueId();
        try
        {
            await admin.PostJsonAsync(Path, Request(id)).ExpectAsync(HttpStatusCode.OK);

            using var changed = await admin.PutAsJsonAsync($"{Path}/{id}", Request(id, displayName: "Renamed", clientSecret: null));
            var provider = (await changed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("providers").EnumerateArray()
                .Single(p => p.GetProperty("id").GetString() == id);

            Assert.Equal("Renamed", provider.GetProperty("displayName").GetString());
            Assert.True(provider.GetProperty("hasClientSecret").GetBoolean());
        }
        finally
        {
            await admin.DeleteAsync(new Uri($"{Path}/{id}", UriKind.Relative));
        }
    }

    [Fact]
    public async Task Added_providers_are_loaded_again_when_the_server_starts()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var id = UniqueId();
        try
        {
            await admin.PostJsonAsync(Path, Request(id)).ExpectAsync(HttpStatusCode.OK);

            // A fresh store reads what was saved, as a restarted server does, and can decrypt the secret.
            using var restarted = ActivatorUtilities.CreateInstance<SignInProviders>(factory.Services);
            await restarted.StartAsync(CancellationToken.None);

            Assert.Contains(new SignInProvider(id, "Second SSO"), restarted.All);
            var options = restarted.ForScheme(AuthSchemes.ForProvider(id));
            Assert.Equal("added-secret", options?.ClientSecret);
            Assert.Equal("second.test", options?.VerifiedDomains);
        }
        finally
        {
            await admin.DeleteAsync(new Uri($"{Path}/{id}", UriKind.Relative));
        }
    }

    [Fact]
    public async Task A_secret_encrypted_with_other_keys_leaves_the_provider_off_the_sign_in_page_without_stopping_the_server()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var id = UniqueId();
        try
        {
            await admin.PostJsonAsync(Path, Request(id)).ExpectAsync(HttpStatusCode.OK);

            // As after restoring the database onto a new disk: the secret was encrypted with keys this server doesn't have.
            using (var scope = factory.Services.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<Inklayer.Infrastructure.Persistence.InklayerDbContext>();
                var setting = db.InstanceSettings.Single(s => s.Key == Inklayer.Domain.Settings.InstanceSetting.SignInProviders);
                var otherKeys = Microsoft.AspNetCore.DataProtection.DataProtectionProvider.Create("another-server").CreateProtector("Inklayer.SignInProviders.v1");
                var foreign = Microsoft.AspNetCore.DataProtection.DataProtectionCommonExtensions.Protect(otherKeys, "added-secret");
                setting.Value = System.Text.RegularExpressions.Regex.Replace(setting.Value, "\"protectedClientSecret\":\"[^\"]+\"",
                    $"\"protectedClientSecret\":\"{foreign}\"");
                await db.SaveChangesAsync();
            }

            using var restarted = ActivatorUtilities.CreateInstance<SignInProviders>(factory.Services);
            await restarted.StartAsync(CancellationToken.None);

            Assert.DoesNotContain(restarted.All, p => p.Id == id);
            Assert.True(restarted.NeedsSecret(id));
            Assert.Contains(restarted.Added, p => p.Id == id);
        }
        finally
        {
            await admin.DeleteAsync(new Uri($"{Path}/{id}", UriKind.Relative));
        }
    }

    [Fact]
    public async Task A_provider_whose_discovery_document_names_another_issuer_is_refused()
    {
        using var admin = await factory.SignInAsAdminAsync();

        using var response = await admin.PostAsJsonAsync(Path, Request(UniqueId(), authority: "https://elsewhere.example.test/"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains(FakeOidcProvider.Issuer, await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("google")]
    [InlineData(InklayerApiFactory.OidcProviderId)]
    [InlineData("Not Valid")]
    public async Task Ids_that_are_taken_or_invalid_are_refused(string id)
    {
        using var admin = await factory.SignInAsAdminAsync();

        using var response = await admin.PostAsJsonAsync(Path, Request(id));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Providers_from_the_configuration_cant_be_changed_or_removed_here()
    {
        using var admin = await factory.SignInAsAdminAsync();

        using var change = await admin.PutAsJsonAsync($"{Path}/{InklayerApiFactory.OidcProviderId}", Request(InklayerApiFactory.OidcProviderId));
        using var remove = await admin.DeleteAsync(new Uri($"{Path}/{InklayerApiFactory.OidcProviderId}", UriKind.Relative));

        Assert.Equal(HttpStatusCode.Conflict, change.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, remove.StatusCode);
    }

    [Fact]
    public async Task Only_instance_administrators_can_see_or_add_providers()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var (person, _) = await Scenario.AddMemberAsync(factory, admin, (await Scenario.CreateOrganizationAsync(admin)).Id, "Owner");

        using var list = await person.GetAsync(new Uri(Path, UriKind.Relative));
        using var add = await person.PostAsJsonAsync(Path, Request(UniqueId()));

        Assert.Equal(HttpStatusCode.Forbidden, list.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, add.StatusCode);
    }

    private static string UniqueId() => "sso-" + Guid.NewGuid().ToString("N")[..8];

    private static object Request(string id, string authority = FakeOidcProvider.Issuer, string displayName = "Second SSO", string? clientSecret = "added-secret") => new
    {
        id,
        displayName,
        authority,
        clientId = FakeOidcProvider.ClientId,
        clientSecret,
        verifiedDomains = new[] { "second.test" },
    };

    private async Task<HttpResponseMessage> SignInThroughAsync(HttpClient browser, string id, Dictionary<string, object> userInfo)
    {
        using var login = await browser.GetAsync(new Uri($"/auth/login?provider={id}", UriKind.Relative));
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        var query = System.Web.HttpUtility.ParseQueryString(login.Headers.Location!.Query);
        Assert.Equal($"https://localhost/auth/callback/{id}", query["redirect_uri"]);
        var code = factory.Oidc.IssueCode(query["nonce"]!, userInfo);
        return await browser.GetAsync(new Uri($"/auth/callback/{id}?code={code}&state={Uri.EscapeDataString(query["state"]!)}", UriKind.Relative));
    }
}
