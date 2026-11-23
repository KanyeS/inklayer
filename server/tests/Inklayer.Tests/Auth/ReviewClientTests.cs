using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Inklayer.Tests.Features;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.Tokens;

namespace Inklayer.Tests.Auth;

/// <summary>
/// The review helper (client/apps/review): a first-party client that signs in through the browser to a loopback address,
/// once the person allows it, and gets tokens for the API (unlike apps that register themselves, which only get MCP).
/// </summary>
[Collection(ApiTestGroup.Name)]
public sealed partial class ReviewClientTests(InklayerApiFactory factory)
{
    private const string ClientId = "inklayer-review";
    private const string Redirect = "http://127.0.0.1:47821/callback";
    private static readonly Uri Me = new("/api/me", UriKind.Relative);

    [Fact]
    public async Task Review_helper_gets_api_tokens_once_the_person_allows_it()
    {
        var (browser, me) = await NewMemberAsync();
        var verifier = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));

        // Asked once, as a named first-party app (not flagged as unverified).
        using var consent = await browser.GetAsync(AuthorizeUrl(verifier));
        var page = await consent.Content.ReadAsStringAsync();
        Assert.Equal(HttpStatusCode.OK, consent.StatusCode);
        Assert.Contains("Inklayer review helper (Claude Code)", page, StringComparison.Ordinal);
        Assert.DoesNotContain("Unverified app", page, StringComparison.Ordinal);

        using var allowed = await browser.PostAsync(new Uri("/connect/authorize", UriKind.Relative), ConsentForm(page, "allow"));
        var tokens = await RedeemAsync(allowed, verifier);

        using var api = Bearer(tokens.AccessToken);
        Assert.Equal(me.Id, (await (await api.GetAsync(Me)).ReadAsync<MeDto>()).Id);
        Assert.False(string.IsNullOrEmpty(tokens.RefreshToken));

        // Its tokens are for the API, not for MCP.
        using var mcp = await api.PostAsJsonAsync("/api/mcp", new { jsonrpc = "2.0", id = 1, method = "ping" });
        Assert.True(mcp.StatusCode is HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized, mcp.StatusCode.ToString());

        // Next time it's not asked again.
        var again = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
        using var silent = await browser.GetAsync(AuthorizeUrl(again));
        Assert.Equal(HttpStatusCode.Redirect, silent.StatusCode);
        browser.Dispose();
    }

    [Fact]
    public async Task Comments_the_review_helper_leaves_say_they_came_via_claude_code()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (browser, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var verifier = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
        using var consent = await browser.GetAsync(AuthorizeUrl(verifier));
        using var allowed = await browser.PostAsync(new Uri("/connect/authorize", UriKind.Relative), ConsentForm(await consent.Content.ReadAsStringAsync(), "allow"));
        using var helper = Bearer((await RedeemAsync(allowed, verifier)).AccessToken);

        var comment = new
        {
            url = "https://site.example/settings",
            kind = "Element",
            body = "Saving does nothing.",
            anchor = new { element = new { path = new[] { "#save" }, tag = "button" } },
            geometry = new { kind = "Element" },
        };
        using var byHelper = await helper.PostAsJsonAsync($"/api/projects/{project.Id}/live/annotations", comment);
        Assert.Equal(HttpStatusCode.Created, byHelper.StatusCode);
        Assert.Equal("Claude Code", (await byHelper.ReadAsync<ViaDto>(HttpStatusCode.Created)).Via);

        // Made by the person themselves: no "via".
        using var byPerson = await browser.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", comment);
        Assert.Equal("", (await byPerson.ReadAsync<ViaDto>(HttpStatusCode.Created)).Via);

        // Listed with it too.
        using var list = await browser.GetAsync(new Uri("/api/live/annotations?url=https%3A%2F%2Fsite.example%2Fsettings", UriKind.Relative));
        var pages = await list.ReadAsync<List<PageDto>>();
        Assert.Equal(["", "Claude Code"], pages.SelectMany(p => p.Annotations).Select(a => a.Via).Order().ToList());
        browser.Dispose();
    }

    private sealed record ViaDto(Guid Id, string Via);

    private sealed record PageDto(List<ViaDto> Annotations);

    [Fact]
    public async Task People_can_disconnect_the_review_helper()
    {
        var (browser, _) = await NewMemberAsync();
        var verifier = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
        using var consent = await browser.GetAsync(AuthorizeUrl(verifier));
        using var allowed = await browser.PostAsync(new Uri("/connect/authorize", UriKind.Relative), ConsentForm(await consent.Content.ReadAsStringAsync(), "allow"));
        var tokens = await RedeemAsync(allowed, verifier);

        using (var apps = await browser.GetAsync(new Uri("/api/me/apps", UriKind.Relative)))
        {
            var app = Assert.Single(await apps.ReadAsync<List<Inklayer.Tests.Mcp.McpTests.ConnectedAppDto>>());
            Assert.Equal(ClientId, app.ClientId);
        }

        await browser.DeleteAsync(new Uri($"/api/me/apps/{ClientId}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        using var api = Bearer(tokens.AccessToken);
        await api.GetAsync(Me).ExpectAsync(HttpStatusCode.Unauthorized);
        browser.Dispose();
    }

    [Theory]
    [InlineData("http://127.0.0.1:9999/callback")] // a loopback port it doesn't use
    [InlineData("https://attacker.example/callback")]
    public async Task Review_helper_only_signs_in_to_its_own_loopback_addresses(string redirectUri)
    {
        var (browser, _) = await NewMemberAsync();
        using var response = await browser.GetAsync(AuthorizeUrl("verifier-verifier-verifier-verifier-verifier", redirectUri));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        browser.Dispose();
    }

    private async Task<(HttpClient Browser, MeDto Me)> NewMemberAsync()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        return await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
    }

    private static Uri AuthorizeUrl(string verifier, string redirectUri = Redirect) =>
        new(QueryHelpers.AddQueryString("/connect/authorize", new Dictionary<string, string?>
        {
            ["client_id"] = ClientId,
            ["redirect_uri"] = redirectUri,
            ["response_type"] = "code",
            ["scope"] = "openid profile offline_access",
            ["code_challenge"] = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))),
            ["code_challenge_method"] = "S256",
            ["state"] = "s1",
        }), UriKind.Relative);

    private async Task<TokenDto> RedeemAsync(HttpResponseMessage allowed, string verifier)
    {
        Assert.Equal(HttpStatusCode.Redirect, allowed.StatusCode);
        var location = allowed.Headers.Location!;
        Assert.StartsWith(Redirect, location.ToString(), StringComparison.Ordinal);
        using var client = factory.CreateClient();
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = QueryHelpers.ParseQuery(location.Query)["code"].ToString(),
            ["redirect_uri"] = Redirect,
            ["client_id"] = ClientId,
            ["code_verifier"] = verifier,
        });
        using var token = await client.PostAsync(new Uri("/connect/token", UriKind.Relative), form);
        return await token.ReadAsync<TokenDto>();
    }

    private HttpClient Bearer(string accessToken)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        return client;
    }

    private static FormUrlEncodedContent ConsentForm(string page, string decision)
    {
        var fields = HiddenField().Matches(page).ToDictionary(m => WebUtility.HtmlDecode(m.Groups["name"].Value), m => WebUtility.HtmlDecode(m.Groups["value"].Value));
        fields["consent"] = decision;
        return new FormUrlEncodedContent(fields);
    }

    [GeneratedRegex("""<input type="hidden" name="(?<name>[^"]*)" value="(?<value>[^"]*)">""")]
    private static partial Regex HiddenField();
}
