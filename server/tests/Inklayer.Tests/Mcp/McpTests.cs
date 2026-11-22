using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Inklayer.Tests.Features;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.Tokens;
using ModelContextProtocol.Client;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;

namespace Inklayer.Tests.Mcp;

/// <summary>
/// The MCP endpoint, as a client such as Claude uses it: discover the authorization server, register, sign the person in,
/// ask their consent, then call tools that act as them.
/// </summary>
[Collection(ApiTestGroup.Name)]
public sealed partial class McpTests(InklayerApiFactory factory)
{
    private const string Resource = "http://localhost/api/mcp";
    private const string Redirect = "http://127.0.0.1:33418/callback";

    /* ------------------------------------------------------------------ discovery and registration */

    [Fact]
    public async Task Clients_discover_where_to_sign_in()
    {
        using var anonymous = factory.CreateClient();
        using var unauthorized = await anonymous.PostAsJsonAsync("/api/mcp", new { jsonrpc = "2.0", id = 1, method = "ping" });
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
        Assert.Contains("resource_metadata=\"http://localhost/.well-known/oauth-protected-resource/api/mcp\"",
            unauthorized.Headers.WwwAuthenticate.ToString(), StringComparison.Ordinal);

        using var resource = JsonDocument.Parse(await anonymous.GetStringAsync(new Uri("/.well-known/oauth-protected-resource/api/mcp", UriKind.Relative)));
        Assert.Equal(Resource, resource.RootElement.GetProperty("resource").GetString());
        Assert.Equal("http://localhost/", resource.RootElement.GetProperty("authorization_servers")[0].GetString());

        using var server = JsonDocument.Parse(await anonymous.GetStringAsync(new Uri("/.well-known/oauth-authorization-server", UriKind.Relative)));
        Assert.Equal("http://localhost/connect/register", server.RootElement.GetProperty("registration_endpoint").GetString());
        Assert.Equal(["S256"], server.RootElement.GetProperty("code_challenge_methods_supported").EnumerateArray().Select(e => e.GetString()));
        Assert.Contains("mcp", server.RootElement.GetProperty("scopes_supported").EnumerateArray().Select(e => e.GetString()));
    }

    [Theory]
    [InlineData("http://evil.example/callback", null)]
    [InlineData("https://claude.ai/api/mcp/auth_callback#x", null)]
    [InlineData("http://127.0.0.1:5000/cb", "client_secret_basic")]
    public async Task Registration_allows_only_public_clients_with_safe_redirects(string redirect, string? authMethod)
    {
        using var anonymous = factory.CreateClient();
        using var response = await anonymous.PostAsJsonAsync("/connect/register",
            new Dictionary<string, object?> { ["client_name"] = "Bad", ["redirect_uris"] = new[] { redirect }, ["token_endpoint_auth_method"] = authMethod });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    /* ------------------------------------------------------------------ sign-in, consent and tokens */

    [Fact]
    public async Task People_allow_an_app_once_and_it_can_then_act_as_them()
    {
        var (admin, orgId, member) = await MemberAsync("Commenter");
        var clientId = await RegisterAsync("Claude (test)");

        var (consent, _) = await AuthorizeAsync(member, clientId);
        Assert.Contains("Allow Claude (test) to use Inklayer?", consent, StringComparison.Ordinal);
        // It registered itself, so it chose that name: the page says so.
        Assert.Contains("Unverified app.", consent, StringComparison.Ordinal);
        var tokens = await AllowAsync(member, clientId, consent);

        // The second time, no consent page: straight back to the app.
        var (_, code) = await AuthorizeAsync(member, clientId);
        Assert.NotNull(code);

        await using var mcp = await ConnectAsync(tokens.AccessToken);
        var tools = await mcp.ListToolsAsync();
        Assert.Contains(tools, t => t.Name == "edit_doc");
        Assert.True(tools.Single(t => t.Name == "read_doc").ProtocolTool.Annotations?.ReadOnlyHint);
        Assert.True(tools.Single(t => t.Name == "delete_doc").ProtocolTool.Annotations?.DestructiveHint);

        var whoami = Text(await mcp.CallToolAsync("whoami"));
        Assert.Contains(orgId.ToString(), whoami, StringComparison.Ordinal);

        // Refreshing keeps the token for the MCP endpoint.
        var refreshed = await TokenAsync(new() { ["grant_type"] = "refresh_token", ["refresh_token"] = tokens.RefreshToken!, ["client_id"] = clientId });
        await using var again = await ConnectAsync(refreshed.AccessToken);
        Assert.Contains(orgId.ToString(), Text(await again.CallToolAsync("whoami")), StringComparison.Ordinal);
        admin.Dispose();
        member.Dispose();
    }

    [Fact]
    public async Task Saying_no_sends_the_app_away_without_a_code()
    {
        var (admin, _, member) = await MemberAsync("Commenter");
        var clientId = await RegisterAsync("Not trusted");
        var (consent, _) = await AuthorizeAsync(member, clientId);

        using var denied = await member.PostAsync(new Uri("/connect/authorize", UriKind.Relative), ConsentForm(consent, "deny"));
        Assert.Equal(HttpStatusCode.Redirect, denied.StatusCode);
        var query = QueryHelpers.ParseQuery(denied.Headers.Location!.Query);
        Assert.Equal("access_denied", query["error"].ToString());
        Assert.False(query.ContainsKey("code"));
        admin.Dispose();
        member.Dispose();
    }

    [Fact]
    public async Task Tokens_only_work_where_they_were_issued_for()
    {
        var (admin, _, member) = await MemberAsync("Commenter");
        var tokens = await SignInAppAsync(member);

        // An MCP token can't be used on the rest of the API…
        using var api = factory.CreateClient();
        api.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", tokens.AccessToken);
        await api.GetAsync(new Uri("/api/me", UriKind.Relative)).ExpectAsync(HttpStatusCode.Unauthorized);

        admin.Dispose();
        member.Dispose();
    }

    [Fact]
    public async Task Apps_that_register_themselves_only_get_tokens_for_mcp()
    {
        var (admin, _, member) = await MemberAsync("Commenter");
        var clientId = await RegisterAsync("Claude (test)");

        // Leaving the resource out would give a token with no audience, good for the whole API: refused, with no code.
        using var response = await member.GetAsync(new Uri(QueryHelpers.AddQueryString("/connect/authorize", new Dictionary<string, string?>
        {
            ["client_id"] = clientId,
            ["redirect_uri"] = Redirect,
            ["response_type"] = "code",
            ["scope"] = "mcp offline_access",
            ["code_challenge"] = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes("verifier-verifier-verifier-verifier-verifier"))),
            ["code_challenge_method"] = "S256",
            ["state"] = "s1",
        }), UriKind.Relative));

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        var query = QueryHelpers.ParseQuery(response.Headers.Location!.Query);
        Assert.Equal("invalid_target", query["error"].ToString());
        Assert.False(query.ContainsKey("code"));
        admin.Dispose();
        member.Dispose();
    }

    /* ------------------------------------------------------------------ tools act as the person */

    [Fact]
    public async Task Tools_respect_the_persons_role()
    {
        var (admin, orgId, commenter) = await MemberAsync("Commenter");
        var (viewer, _) = await Scenario.AddProjectMemberAsync(factory, admin, orgId, "Viewer");
        await using var asCommenter = await ConnectAsync((await SignInAppAsync(commenter)).AccessToken);
        await using var asViewer = await ConnectAsync((await SignInAppAsync(viewer)).AccessToken);

        var createdText = Text(await asCommenter.CallToolAsync("create_doc",
            new Dictionary<string, object?> { ["orgId"] = orgId, ["title"] = "Launch plan", ["content"] = "# Launch\n\nShip it #q3" }));
        Assert.StartsWith("{", createdText, StringComparison.Ordinal);
        var created = JsonDocument.Parse(createdText);
        var docId = created.RootElement.GetProperty("id").GetGuid();

        var read = Text(await asViewer.CallToolAsync("read_doc", new Dictionary<string, object?> { ["docId"] = docId }));
        Assert.Contains("Ship it #q3", read, StringComparison.Ordinal);
        Assert.Contains("\"tags\":[\"q3\"]", read, StringComparison.Ordinal);

        var refused = await asViewer.CallToolAsync("edit_doc", new Dictionary<string, object?> { ["docId"] = docId, ["mode"] = "append", ["text"] = "nope" });
        Assert.True(refused.IsError);
        Assert.Contains("Your role doesn't allow this.", Text(refused), StringComparison.Ordinal);

        // Another organisation's doc doesn't exist, as far as an outsider can tell.
        var (otherAdmin, _, outsider) = await MemberAsync("Owner");
        await using var asOutsider = await ConnectAsync((await SignInAppAsync(outsider)).AccessToken);
        var hidden = await asOutsider.CallToolAsync("read_doc", new Dictionary<string, object?> { ["docId"] = docId });
        Assert.True(hidden.IsError);
        Assert.Contains("Not found", Text(hidden), StringComparison.Ordinal);
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
        otherAdmin.Dispose();
        outsider.Dispose();
    }

    [Fact]
    public async Task Doc_edits_reach_people_editing_live_and_keep_unicode_offsets()
    {
        var (admin, orgId, commenter) = await MemberAsync("Commenter");
        await using var mcp = await ConnectAsync((await SignInAppAsync(commenter)).AccessToken);
        var docId = JsonDocument.Parse(Text(await mcp.CallToolAsync("create_doc",
            new Dictionary<string, object?> { ["orgId"] = orgId, ["title"] = "Notes", ["content"] = "Café 👋 opens at 9" }))).RootElement.GetProperty("id").GetGuid();

        await using var browser = await DocsProbe.ConnectAsync(factory, commenter);
        var opened = await browser.OpenAsync(docId);

        var edit = await mcp.CallToolAsync("edit_doc", new Dictionary<string, object?> { ["docId"] = docId, ["mode"] = "replace_text", ["find"] = "9", ["text"] = "10" });
        Assert.True(edit.IsError != true, Text(edit));
        var update = await browser.NextAsync("update");
        Assert.StartsWith($"{opened.SnapshotSeq + 1}:", update.Data, StringComparison.Ordinal);

        using var read = JsonDocument.Parse(Text(await mcp.CallToolAsync("read_doc", new Dictionary<string, object?> { ["docId"] = docId })));
        Assert.Equal("Café 👋 opens at 10", read.RootElement.GetProperty("markdown").GetString());

        var ambiguous = await mcp.CallToolAsync("edit_doc", new Dictionary<string, object?> { ["docId"] = docId, ["mode"] = "replace_text", ["find"] = " ", ["text"] = "_" });
        Assert.True(ambiguous.IsError);

        using var search = await commenter.GetAsync(new Uri($"/api/orgs/{orgId}/docs/search?q=opens", UriKind.Relative));
        Assert.Single(await search.ReadAsync<List<DocSearchDto>>());
        admin.Dispose();
        commenter.Dispose();
    }

    [Fact]
    public async Task Comment_tools_reply_and_resolve()
    {
        var (admin, orgId, commenter) = await MemberAsync("Commenter");
        var project = await Scenario.CreateProjectAsync(admin, orgId);
        using (var me = await commenter.GetAsync(new Uri("/api/me", UriKind.Relative)))
        {
            await Scenario.GrantAsync(admin, project.Id, (await me.ReadAsync<MeDto>()).Id, "Commenter");
        }

        var url = $"https://site-{Guid.NewGuid():N}.example/page";
        using (var created = await commenter.PostJsonAsync($"/api/projects/{project.Id}/live/annotations",
            new { url, kind = "Pin", body = "Typo in the heading", anchor = new { element = new { path = new[] { "h1" }, tag = "h1" } }, geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } }, viewportWidth = 1200 }))
        {
            await created.ReadAsync<AnnotationDto>(HttpStatusCode.Created);
        }

        await using var mcp = await ConnectAsync((await SignInAppAsync(commenter)).AccessToken);
        var comments = JsonDocument.Parse(Text(await mcp.CallToolAsync("list_comments", new Dictionary<string, object?> { ["url"] = url })));
        var commentId = comments.RootElement[0].GetProperty("comments")[0].GetProperty("id").GetGuid();

        Assert.NotEqual(true, (await mcp.CallToolAsync("reply_to_comment", new Dictionary<string, object?> { ["commentId"] = commentId, ["body"] = "Fixed in #42" })).IsError);
        var resolved = Text(await mcp.CallToolAsync("set_comment_status", new Dictionary<string, object?> { ["commentId"] = commentId, ["resolved"] = true }));
        Assert.Contains("\"status\":\"Resolved\"", resolved, StringComparison.Ordinal);
        Assert.Contains("Fixed in #42", resolved, StringComparison.Ordinal);
        admin.Dispose();
        commenter.Dispose();
    }

    [Fact]
    public async Task People_see_and_disconnect_their_connected_apps()
    {
        var (admin, _, member) = await MemberAsync("Commenter");
        var tokens = await SignInAppAsync(member, name: "Claude Desktop");

        using (var apps = await member.GetAsync(new Uri("/api/me/apps", UriKind.Relative)))
        {
            var app = Assert.Single(await apps.ReadAsync<List<ConnectedAppDto>>());
            Assert.Equal("Claude Desktop", app.Name);
            await member.DeleteAsync(new Uri($"/api/me/apps/{Uri.EscapeDataString(app.ClientId)}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        }

        using var refresh = await PostTokenAsync(new() { ["grant_type"] = "refresh_token", ["refresh_token"] = tokens.RefreshToken!, ["client_id"] = tokens.ClientId });
        Assert.Equal(HttpStatusCode.BadRequest, refresh.StatusCode);
        using var none = await member.GetAsync(new Uri("/api/me/apps", UriKind.Relative));
        Assert.Empty(await none.ReadAsync<List<ConnectedAppDto>>());
        admin.Dispose();
        member.Dispose();
    }

    [Fact]
    public async Task Assistants_see_open_comments_with_their_page_details_and_screenshot()
    {
        var (admin, projectId, author, other, viewer, url, commentId) = await Annotations.BugContextTests.SetUpAsync(factory);
        await author.PutJsonAsync($"/api/annotations/{commentId}/context", Annotations.BugContextTests.Context).ExpectAsync(HttpStatusCode.NoContent);
        var content = new ByteArrayContent(Annotations.BugContextTests.WebP);
        content.Headers.ContentType = new MediaTypeHeaderValue("image/webp");
        await author.PutAsync(new Uri($"/api/annotations/{commentId}/screenshot", UriKind.Relative), content).ExpectAsync(HttpStatusCode.NoContent);

        await using var mcp = await ConnectAsync((await SignInAppAsync(viewer)).AccessToken);
        var open = Text(await mcp.CallToolAsync("list_open_comments", new Dictionary<string, object?> { ["projectId"] = projectId, ["url"] = url }));
        Assert.Contains("TypeError: price is undefined", open, StringComparison.Ordinal);
        Assert.Contains("\"hasScreenshot\":true", open, StringComparison.Ordinal);

        var image = Assert.IsType<ImageContentBlock>(Assert.Single((await mcp.CallToolAsync("get_comment_screenshot", new Dictionary<string, object?> { ["commentId"] = commentId })).Content));
        Assert.Equal("image/webp", image.MimeType);
        foreach (var c in new[] { admin, author, other, viewer })
        {
            c.Dispose();
        }
    }

    [Fact]
    public async Task Renaming_a_doc_rewrites_links_to_it_in_other_docs()
    {
        var (admin, orgId, commenter) = await MemberAsync("Commenter");
        await using var mcp = await ConnectAsync((await SignInAppAsync(commenter)).AccessToken);
        var call = async (string tool, Dictionary<string, object?> args) => Text(await mcp.CallToolAsync(tool, args));
        var target = JsonDocument.Parse(await call("create_doc", new() { ["orgId"] = orgId, ["title"] = "Spec" })).RootElement.GetProperty("id").GetGuid();
        var source = JsonDocument.Parse(await call("create_doc", new() { ["orgId"] = orgId, ["title"] = "Index", ["content"] = "See [[Spec#Risks|the spec]] and [[Specs]]" }))
            .RootElement.GetProperty("id").GetGuid();

        Assert.Contains("\"updatedLinksIn\":1", await call("rename_or_move_doc", new() { ["docId"] = target, ["title"] = "Checkout spec" }), StringComparison.Ordinal);
        using var read = JsonDocument.Parse(await call("read_doc", new() { ["docId"] = source }));
        Assert.Equal("See [[Checkout spec#Risks|the spec]] and [[Specs]]", read.RootElement.GetProperty("markdown").GetString());
        admin.Dispose();
        commenter.Dispose();
    }

    [Fact]
    public async Task Apps_nobody_allowed_are_pruned()
    {
        var clientId = await RegisterAsync("Abandoned");
        await using var scope = factory.Services.CreateAsyncScope();
        var applications = scope.ServiceProvider.GetRequiredService<OpenIddict.Abstractions.IOpenIddictApplicationManager>();
        Assert.NotNull(await applications.FindByClientIdAsync(clientId));

        await Inklayer.Api.Auth.TokenPruningService.PruneUnusedAppsAsync(scope.ServiceProvider, DateTimeOffset.UtcNow.AddMinutes(1), CancellationToken.None);
        Assert.Null(await applications.FindByClientIdAsync(clientId));
    }

    [Theory]
    [InlineData("Café 👋 opens at 9", "Café 👋 opens at 10", 17, 1, "10")] // the emoji is two UTF-16 units
    [InlineData("abc", "abc", 3, 0, "")]
    [InlineData("a👋b", "a😀b", 1, 2, "😀")] // never half an emoji
    [InlineData("", "new", 0, 0, "new")]
    public void Edits_change_only_what_differs(string before, string after, int index, int delete, string insert)
    {
        Assert.Equal(new Inklayer.Api.Features.Docs.TextEdit(index, delete, insert), Inklayer.Api.Features.Mcp.InklayerTools.Minimal(before, after));
    }

    /* ------------------------------------------------------------------ helpers */

    public sealed record ConnectedAppDto(string ClientId, string Name, DateTime? AuthorizedAt);

    private sealed record AppTokens(string AccessToken, string? RefreshToken, string ClientId);

    private async Task<(HttpClient Admin, Guid OrgId, HttpClient Member)> MemberAsync(string role)
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (member, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, role);
        return (admin, org.Id, member);
    }

    private async Task<string> RegisterAsync(string name)
    {
        using var anonymous = factory.CreateClient();
        using var response = await anonymous.PostAsJsonAsync("/connect/register",
            new Dictionary<string, object?> { ["client_name"] = name, ["redirect_uris"] = new[] { Redirect }, ["token_endpoint_auth_method"] = "none" });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return body.RootElement.GetProperty("client_id").GetString()!;
    }

    private string _verifier = "";

    /// <summary>Starts sign-in in the person's browser. Returns the consent page, or the code if they'd allowed the app before.</summary>
    private async Task<(string ConsentPage, string? Code)> AuthorizeAsync(HttpClient browser, string clientId, string? resource = Resource)
    {
        _verifier = Base64UrlEncoder.Encode(RandomNumberGenerator.GetBytes(32));
        var parameters = new Dictionary<string, string?>
        {
            ["client_id"] = clientId,
            ["redirect_uri"] = Redirect,
            ["response_type"] = "code",
            ["scope"] = "mcp offline_access",
            ["code_challenge"] = Base64UrlEncoder.Encode(SHA256.HashData(Encoding.ASCII.GetBytes(_verifier))),
            ["code_challenge_method"] = "S256",
            ["state"] = "s1",
        };
        if (resource is not null)
        {
            parameters["resource"] = resource;
        }

        using var response = await browser.GetAsync(new Uri(QueryHelpers.AddQueryString("/connect/authorize", parameters), UriKind.Relative));
        if (response.StatusCode == HttpStatusCode.Redirect)
        {
            return ("", CodeFrom(response));
        }

        var page = await response.Content.ReadAsStringAsync();
        Assert.True(response.StatusCode == HttpStatusCode.OK, $"{response.StatusCode}: {page}");
        // No other site may frame the consent page (its "Allow" button could be clickjacked).
        Assert.Contains("frame-ancestors 'none'", string.Join(';', response.Headers.GetValues("Content-Security-Policy")), StringComparison.Ordinal);
        Assert.Equal("DENY", Assert.Single(response.Headers.GetValues("X-Frame-Options")));
        return (page, null);
    }

    private async Task<AppTokens> AllowAsync(HttpClient browser, string clientId, string consentPage)
    {
        using var allowed = await browser.PostAsync(new Uri("/connect/authorize", UriKind.Relative), ConsentForm(consentPage, "allow"));
        Assert.Equal(HttpStatusCode.Redirect, allowed.StatusCode);
        var tokens = await TokenAsync(new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = CodeFrom(allowed),
            ["redirect_uri"] = Redirect,
            ["client_id"] = clientId,
            ["code_verifier"] = _verifier,
        });
        return tokens with { ClientId = clientId };
    }

    private async Task<AppTokens> SignInAppAsync(HttpClient browser, string? resource = Resource, string name = "Claude (test)")
    {
        var clientId = await RegisterAsync(name);
        var (consent, _) = await AuthorizeAsync(browser, clientId, resource);
        return await AllowAsync(browser, clientId, consent);
    }

    private static FormUrlEncodedContent ConsentForm(string page, string decision)
    {
        var fields = HiddenField().Matches(page).ToDictionary(m => WebUtility.HtmlDecode(m.Groups["name"].Value), m => WebUtility.HtmlDecode(m.Groups["value"].Value));
        fields["consent"] = decision;
        return new FormUrlEncodedContent(fields);
    }

    private static string CodeFrom(HttpResponseMessage redirect)
    {
        var location = redirect.Headers.Location!;
        Assert.StartsWith(Redirect, location.ToString(), StringComparison.Ordinal);
        return QueryHelpers.ParseQuery(location.Query)["code"].ToString();
    }

    private async Task<AppTokens> TokenAsync(Dictionary<string, string> form)
    {
        using var response = await PostTokenAsync(form);
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode, body);
        using var json = JsonDocument.Parse(body);
        return new AppTokens(json.RootElement.GetProperty("access_token").GetString()!,
            json.RootElement.TryGetProperty("refresh_token", out var refresh) ? refresh.GetString() : null, form["client_id"]);
    }

    private async Task<HttpResponseMessage> PostTokenAsync(Dictionary<string, string> form)
    {
        using var client = factory.CreateClient();
        using var content = new FormUrlEncodedContent(form);
        return await client.PostAsync(new Uri("/connect/token", UriKind.Relative), content);
    }

    private async Task<McpClient> ConnectAsync(string accessToken)
    {
        var http = factory.CreateClient();
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        var transport = new HttpClientTransport(new HttpClientTransportOptions { Endpoint = new Uri(Resource), TransportMode = HttpTransportMode.StreamableHttp }, http, ownsHttpClient: true);
        return await McpClient.CreateAsync(transport);
    }

    private static string Text(CallToolResult result) => string.Concat(result.Content.OfType<TextContentBlock>().Select(c => c.Text));

    [GeneratedRegex("""<input type="hidden" name="(?<name>[^"]*)" value="(?<value>[^"]*)">""")]
    private static partial Regex HiddenField();
}
