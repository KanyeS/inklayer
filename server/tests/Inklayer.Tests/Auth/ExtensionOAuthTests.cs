using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.Tokens;

namespace Inklayer.Tests.Auth;

/// <summary>The browser extension's sign-in: OAuth 2.0 authorization code + PKCE against Inklayer's own token server.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class ExtensionOAuthTests(InklayerApiFactory factory)
{
    private const string ClientId = "inklayer-extension";
    private static readonly Uri Me = new("/api/me", UriKind.Relative);

    [Fact]
    public async Task Extension_gets_tokens_that_work_against_the_api()
    {
        using var browser = await factory.SignInAsAdminAsync();

        var tokens = await AuthorizeAndRedeemAsync(browser);

        using var extension = BearerClient(tokens.AccessToken);
        using var response = await extension.GetAsync(Me);
        var me = await response.ReadAsync<MeDto>();
        Assert.Equal(InklayerApiFactory.BootstrapAdminEmail, me.Email);
        Assert.False(string.IsNullOrEmpty(tokens.RefreshToken));
    }

    [Fact]
    public async Task Bearer_requests_do_not_need_the_csrf_header()
    {
        using var browser = await factory.SignInAsAdminAsync();
        var tokens = await AuthorizeAndRedeemAsync(browser);
        using var extension = BearerClient(tokens.AccessToken);

        await extension.PostJsonAsync("/api/orgs", new { name = "Created from the extension" }).ExpectAsync(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Refresh_tokens_rotate()
    {
        using var browser = await factory.SignInAsAdminAsync();
        var first = await AuthorizeAndRedeemAsync(browser);

        var second = await RefreshAsync(first.RefreshToken!);

        Assert.NotEqual(first.RefreshToken, second.RefreshToken);
        using var extension = BearerClient(second.AccessToken);
        await extension.GetAsync(Me).ExpectAsync(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Authorize_without_a_session_redirects_to_sign_in_and_back()
    {
        using var anonymous = factory.CreateBrowserClient();
        var (url, _) = AuthorizeUrl();

        using var response = await anonymous.GetAsync(url);

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        var location = response.Headers.Location!.ToString();
        Assert.StartsWith("http://localhost/auth/login?returnUrl=", location, StringComparison.Ordinal);
        Assert.Contains(Uri.EscapeDataString("/connect/authorize?"), location, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Unregistered_redirect_uris_are_rejected()
    {
        using var browser = await factory.SignInAsAdminAsync();
        var (url, _) = AuthorizeUrl(redirectUri: "https://attacker.example/callback");

        using var response = await browser.GetAsync(url);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Theory]
    [InlineData("https://cihhaaceflhcncmeoiembekghkhbgfio.chromiumapp.org/")] // Chrome Web Store build
    [InlineData("https://01fc551d14085f05b25b6448f79709265f7c52ab.extensions.allizom.org/")] // Firefox build
    public async Task Official_extension_redirect_uris_are_allowed_without_configuration(string redirectUri)
    {
        using var browser = await factory.SignInAsAdminAsync();
        var (url, _) = AuthorizeUrl(redirectUri);

        using var response = await browser.GetAsync(url);

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.StartsWith(redirectUri, response.Headers.Location!.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Pkce_is_required()
    {
        using var browser = await factory.SignInAsAdminAsync();
        var url = new Uri(QueryHelpers.AddQueryString("/connect/authorize", new Dictionary<string, string?>
        {
            ["client_id"] = ClientId,
            ["redirect_uri"] = InklayerApiFactory.ExtensionRedirectUri,
            ["response_type"] = "code",
            ["scope"] = "openid email profile offline_access",
        }), UriKind.Relative);

        using var response = await browser.GetAsync(url);

        // Refused outright: no redirect, so no code is ever issued.
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(response.Headers.Location);
        Assert.Contains("code_challenge", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Sign_out_everywhere_revokes_extension_tokens()
    {
        var (browser, _) = await NewMemberAsync();
        var tokens = await AuthorizeAndRedeemAsync(browser);

        await browser.PostAsync(new Uri("/api/me/sessions/revoke", UriKind.Relative), null).ExpectAsync(HttpStatusCode.NoContent);

        using var extension = BearerClient(tokens.AccessToken);
        await extension.GetAsync(Me).ExpectAsync(HttpStatusCode.Unauthorized);
        using var refresh = await PostTokenAsync(new() { ["grant_type"] = "refresh_token", ["refresh_token"] = tokens.RefreshToken!, ["client_id"] = ClientId });
        Assert.Equal(HttpStatusCode.BadRequest, refresh.StatusCode);
        browser.Dispose();
    }

    [Fact]
    public async Task Disabled_users_lose_extension_access()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var (browser, me) = await NewMemberAsync();
        var tokens = await AuthorizeAndRedeemAsync(browser);

        await admin.PostAsync(new Uri($"/api/admin/users/{me.Id}/disable", UriKind.Relative), null).ExpectAsync(HttpStatusCode.NoContent);

        using var extension = BearerClient(tokens.AccessToken);
        await extension.GetAsync(Me).ExpectAsync(HttpStatusCode.Unauthorized);
        using var refresh = await PostTokenAsync(new() { ["grant_type"] = "refresh_token", ["refresh_token"] = tokens.RefreshToken!, ["client_id"] = ClientId });
        Assert.Equal(HttpStatusCode.BadRequest, refresh.StatusCode);
        browser.Dispose();
    }

    private async Task<(HttpClient Browser, MeDto Me)> NewMemberAsync()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        return await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");
    }

    private async Task<TokenDto> AuthorizeAndRedeemAsync(HttpClient browser)
    {
        var (url, verifier) = AuthorizeUrl();
        using var authorize = await browser.GetAsync(url);
        Assert.Equal(HttpStatusCode.Redirect, authorize.StatusCode);
        var location = authorize.Headers.Location!;
        Assert.StartsWith(InklayerApiFactory.ExtensionRedirectUri, location.ToString(), StringComparison.Ordinal);
        var query = QueryHelpers.ParseQuery(location.Query);
        Assert.Equal("state-123", query["state"].ToString());

        using var token = await PostTokenAsync(new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = query["code"].ToString(),
            ["redirect_uri"] = InklayerApiFactory.ExtensionRedirectUri,
            ["client_id"] = ClientId,
            ["code_verifier"] = verifier,
        });
        return await token.ReadAsync<TokenDto>();
    }

    private async Task<TokenDto> RefreshAsync(string refreshToken)
    {
        using var response = await PostTokenAsync(new() { ["grant_type"] = "refresh_token", ["refresh_token"] = refreshToken, ["client_id"] = ClientId });
        return await response.ReadAsync<TokenDto>();
    }

    private async Task<HttpResponseMessage> PostTokenAsync(Dictionary<string, string> form)
    {
        using var client = factory.CreateClient();
        using var content = new FormUrlEncodedContent(form);
        return await client.PostAsync(new Uri("/connect/token", UriKind.Relative), content);
    }

    private HttpClient BearerClient(string accessToken)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return client;
    }

    private static (Uri Url, string Verifier) AuthorizeUrl(string redirectUri = InklayerApiFactory.ExtensionRedirectUri)
    {
        var verifier = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
        var challenge = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        var url = QueryHelpers.AddQueryString("/connect/authorize", new Dictionary<string, string?>
        {
            ["client_id"] = ClientId,
            ["redirect_uri"] = redirectUri,
            ["response_type"] = "code",
            ["scope"] = "openid email profile offline_access",
            ["code_challenge"] = challenge,
            ["code_challenge_method"] = "S256",
            ["state"] = "state-123",
        });
        return (new Uri(url, UriKind.Relative), verifier);
    }
}
