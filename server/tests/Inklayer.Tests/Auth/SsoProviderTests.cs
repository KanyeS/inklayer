using System.Net;
using System.Net.Http.Json;
using System.Security.Claims;
using Inklayer.Api.Auth;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Auth;

[Collection(ApiTestGroup.Name)]
public sealed class SsoProviderTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task Providers_endpoint_lists_google_and_the_oidc_provider()
    {
        using var client = factory.CreateBrowserClient();

        var providers = await client.GetFromJsonAsync<List<SignInProvider>>(new Uri("/auth/providers", UriKind.Relative));

        Assert.Equal([new SignInProvider("google", "Google"), new SignInProvider("jumpcloud", "JumpCloud")], providers);
    }

    [Fact]
    public async Task Login_without_a_provider_shows_a_chooser_that_keeps_the_return_url()
    {
        using var client = factory.CreateBrowserClient();

        using var response = await client.GetAsync(new Uri("/auth/login?returnUrl=/orgs/1", UriKind.Relative));
        var html = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Contains("/auth/login?provider=google&amp;returnUrl=%2Forgs%2F1", html, StringComparison.Ordinal);
        Assert.Contains("Sign in with JumpCloud", html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Login_with_an_unknown_provider_is_not_found()
    {
        using var client = factory.CreateBrowserClient();

        using var response = await client.GetAsync(new Uri("/auth/login?provider=nope", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Full_oidc_sign_in_uses_userinfo_claims_and_lands_on_the_return_url()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var email = Identities.UniqueEmail(domain: InklayerApiFactory.OidcVerifiedDomain);
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email, role = "Commenter" }).ExpectAsync(HttpStatusCode.Created);
        using var browser = factory.CreateBrowserClient(https: true);

        // No email_verified claim: the provider's verified domain vouches for the address. Mixed case is normalised.
        using var callback = await SignInThroughProviderAsync(browser, "/orgs/x", new()
        {
            ["sub"] = Guid.NewGuid().ToString("N"),
            ["email"] = email.ToUpperInvariant(),
            ["given_name"] = "Ada",
            ["family_name"] = "Lovelace",
        });

        Assert.Equal(HttpStatusCode.Redirect, callback.StatusCode);
        Assert.Equal("/orgs/x", callback.Headers.Location!.OriginalString);
        using var meResponse = await browser.GetAsync(new Uri("/api/me", UriKind.Relative));
        var me = await meResponse.ReadAsync<MeDto>();
        Assert.Equal(email, me.Email);
        Assert.Equal("Ada Lovelace", me.DisplayName);
        Assert.Contains(me.Organizations, o => o.Id == org.Id && o.Role == "Commenter");
    }

    [Fact]
    public async Task Full_oidc_sign_in_that_the_rules_refuse_ends_on_the_denied_page_without_a_session()
    {
        using var browser = factory.CreateBrowserClient(https: true);

        using var callback = await SignInThroughProviderAsync(browser, "/", new()
        {
            ["sub"] = Guid.NewGuid().ToString("N"),
            ["email"] = Identities.UniqueEmail(domain: InklayerApiFactory.OidcVerifiedDomain),
        });

        Assert.Equal("/auth/denied?reason=NotInvited", callback.Headers.Location!.OriginalString);
        using var me = await browser.GetAsync(new Uri("/api/me", UriKind.Relative));
        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);
    }

    /// <summary>Plays the browser: starts sign-in, "logs in" at the provider, and follows the redirect back to the callback.</summary>
    private async Task<HttpResponseMessage> SignInThroughProviderAsync(HttpClient browser, string returnUrl, Dictionary<string, object> userInfo)
    {
        using var login = await browser.GetAsync(new Uri($"/auth/login?provider=jumpcloud&returnUrl={Uri.EscapeDataString(returnUrl)}", UriKind.Relative));
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        var authorize = login.Headers.Location!;
        Assert.StartsWith(FakeOidcProvider.Issuer + "authorize?", authorize.ToString(), StringComparison.Ordinal);
        var query = System.Web.HttpUtility.ParseQueryString(authorize.Query);
        Assert.Equal("S256", query["code_challenge_method"]);
        Assert.Equal("https://localhost/auth/callback/jumpcloud", query["redirect_uri"]);

        var code = factory.Oidc.IssueCode(query["nonce"]!, userInfo);
        return await browser.GetAsync(new Uri($"/auth/callback/jumpcloud?code={code}&state={Uri.EscapeDataString(query["state"]!)}", UriKind.Relative));
    }

    [Fact]
    public void Oidc_claims_from_a_verified_domain_count_as_verified_and_name_the_domain()
    {
        var provider = Provider(verifiedDomains: "acme.com, other.com");

        var identity = ExternalIdentity.FromOidc(Principal(("sub", "123"), ("email", " Ada@ACME.com "), ("given_name", "Ada"), ("family_name", "Lovelace")), provider);

        Assert.Equal(new ExternalIdentity("jumpcloud", "123", "ada@acme.com", true, "Ada Lovelace", null, "acme.com"), identity);
        Assert.True(identity.IsDomainAuthority);
    }

    [Fact]
    public void Oidc_claims_outside_the_verified_domains_rely_on_email_verified()
    {
        var provider = Provider(verifiedDomains: "acme.com");

        var verified = ExternalIdentity.FromOidc(Principal(("sub", "1"), ("email", "ada@gmail.com"), ("email_verified", "true")), provider);
        var unverified = ExternalIdentity.FromOidc(Principal(("sub", "2"), ("email", "ada@gmail.com")), provider);
        var lookalike = ExternalIdentity.FromOidc(Principal(("sub", "3"), ("email", "ada@evilacme.com")), provider);

        Assert.True(verified.EmailVerified);
        Assert.Null(verified.VerifiedDomain);
        Assert.False(unverified.EmailVerified);
        Assert.False(lookalike.EmailVerified);
        Assert.Null(lookalike.VerifiedDomain);
    }

    [Fact]
    public void Google_workspace_account_is_the_authority_only_for_its_own_domain()
    {
        var own = ExternalIdentity.FromGoogle(Principal(("sub", "1"), ("email", "ada@acme.com"), ("email_verified", "true"), ("hd", "acme.com")));
        var secondary = ExternalIdentity.FromGoogle(Principal(("sub", "2"), ("email", "ada@gmail.com"), ("email_verified", "true"), ("hd", "acme.com")));

        Assert.True(own.IsDomainAuthority);
        Assert.False(secondary.IsDomainAuthority);
    }

    [Theory]
    [InlineData("google", "https://idp.example.test/")]
    [InlineData("Bad Id", "https://idp.example.test/")]
    [InlineData("jumpcloud", "http://idp.example.test/")]
    [InlineData("jumpcloud", "not a url")]
    [InlineData("jumpcloud", "")]
    public void Invalid_provider_configuration_fails_at_startup(string id, string authority)
    {
        var options = new InklayerAuthOptions
        {
            Google = { ClientId = "id", ClientSecret = "secret" },
            Oidc = [new InklayerAuthOptions.OidcProviderOptions { Id = id, Authority = authority, ClientId = "client" }],
        };

        Assert.Throws<InvalidOperationException>(() => options.Validate(allowInsecureHttp: false));
    }

    [Fact]
    public void Valid_provider_configuration_passes()
    {
        var options = new InklayerAuthOptions
        {
            Oidc = [new InklayerAuthOptions.OidcProviderOptions { Id = "jumpcloud", Authority = "https://oauth.id.jumpcloud.com/", ClientId = "client" }],
        };

        options.Validate(allowInsecureHttp: false);
    }

    private static InklayerAuthOptions.OidcProviderOptions Provider(string verifiedDomains) =>
        new() { Id = "jumpcloud", Authority = "https://idp.example.test/", ClientId = "client", VerifiedDomains = verifiedDomains };

    private static ClaimsPrincipal Principal(params (string Type, string Value)[] claims) =>
        new(new ClaimsIdentity(claims.Select(c => new Claim(c.Type, c.Value)), "test"));
}
