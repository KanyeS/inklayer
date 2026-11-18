using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Auth;

[Collection(ApiTestGroup.Name)]
public sealed class SessionTests(InklayerApiFactory factory)
{
    private static readonly Uri Me = new("/api/me", UriKind.Relative);

    [Fact]
    public async Task Api_without_a_session_returns_401_instead_of_redirecting()
    {
        using var client = factory.CreateBrowserClient();

        using var response = await client.GetAsync(Me);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task Cookie_authenticated_writes_require_the_csrf_header()
    {
        using var admin = await factory.SignInAsAdminAsync();
        admin.DefaultRequestHeaders.Remove(Inklayer.Api.Auth.CsrfHeader.Name);

        await admin.PostJsonAsync("/api/orgs", new { name = "No CSRF header" }).ExpectAsync(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Logout_ends_the_session()
    {
        using var admin = await factory.SignInAsAdminAsync();

        await admin.PostAsync(new Uri("/auth/logout", UriKind.Relative), null).ExpectAsync(HttpStatusCode.NoContent);

        await admin.GetAsync(Me).ExpectAsync(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Disabling_a_user_ends_their_session_immediately_and_blocks_sign_in()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var identity = Identities.Consumer();
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = identity.Email, role = "Editor" }).ExpectAsync(HttpStatusCode.Created);
        using var member = await factory.SignInAsync(identity);
        using var meResponse = await member.GetAsync(Me);
        var me = await meResponse.ReadAsync<MeDto>();

        await admin.PostAsync(new Uri($"/api/admin/users/{me.Id}/disable", UriKind.Relative), null).ExpectAsync(HttpStatusCode.NoContent);

        await member.GetAsync(Me).ExpectAsync(HttpStatusCode.Unauthorized);
        Assert.Equal("Disabled", await factory.TrySignInAsync(identity));
    }

    [Fact]
    public async Task Sign_out_everywhere_invalidates_other_sessions()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var identity = Identities.Consumer();
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = identity.Email, role = "Viewer" }).ExpectAsync(HttpStatusCode.Created);
        using var laptop = await factory.SignInAsync(identity);
        using var desktop = await factory.SignInAsync(identity);

        await laptop.PostAsync(new Uri("/api/me/sessions/revoke", UriKind.Relative), null).ExpectAsync(HttpStatusCode.NoContent);

        await desktop.GetAsync(Me).ExpectAsync(HttpStatusCode.Unauthorized);
        await laptop.GetAsync(Me).ExpectAsync(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task Only_instance_administrators_can_use_admin_endpoints()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (owner, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Owner");

        await owner.GetAsync(new Uri("/api/admin/users", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
    }

    [Theory]
    [InlineData("/dashboard", "/dashboard")]
    [InlineData("//evil.example/phish", "/")]
    [InlineData("/\\evil.example", "/")]
    [InlineData("https://evil.example/", "/")]
    [InlineData(null, "/")]
    public void Login_return_urls_are_restricted_to_local_paths(string? returnUrl, string expected)
    {
        Assert.Equal(expected, Inklayer.Api.Auth.AuthEndpoints.SafeReturnUrl(returnUrl));
    }
}
