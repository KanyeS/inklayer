using System.Net;
using System.Text.Json;
using System.Web;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

public sealed record TrackerChoiceDto(Guid Id, string Kind, string Name, string PostsAs, string? Login);

public sealed record TrackerAccountDto(string Kind, string Name, string? Login, string? Url, DateTime? ConnectedAt);

/// <summary>People's own GitHub accounts: connecting with OAuth, acting as them, and the shared account as a fallback.</summary>
public sealed partial class IssueTrackerTests
{
    /// <summary>The fake GitHub's OAuth: code <c>code-x</c> gives token <c>gho_x</c>, which belongs to login <c>x</c>.</summary>
    private void InstallGitHubOAuth()
    {
        factory.Outbound.Responders[$"{InklayerApiFactory.GitHubWeb}/login/oauth/access_token"] = (_, body) =>
        {
            var form = HttpUtility.ParseQueryString(body);
            return form["client_secret"] == "gh-secret" && form["code_verifier"] is { Length: > 40 } && form["code"] is { } code && code.StartsWith("code-", StringComparison.Ordinal)
                ? Json(new { access_token = $"gho_{code[5..]}", token_type = "bearer", scope = "repo" })
                : Json(new { error = "bad_verification_code", error_description = "The code passed is incorrect or expired." });
        };
        factory.Outbound.Responders[$"{InklayerApiFactory.GitHubApi}/user"] = (request, _) =>
        {
            var login = request.Headers.Authorization!.Parameter!["gho_".Length..];
            return Json(new { id = Math.Abs(login.GetHashCode(StringComparison.Ordinal)), login });
        };
        factory.Outbound.Responders[$"{InklayerApiFactory.GitHubApi}/applications/gh-client/grant"] = (_, _) => new HttpResponseMessage(HttpStatusCode.NoContent);
    }

    /// <summary>Goes through "Connect GitHub" as the browser would; returns where it ended up.</summary>
    private static async Task<string> ConnectAccountAsync(HttpClient client, string login, string returnTo = "/projects/x#issues")
    {
        var query = await StartConnectAsync(client, "github", $"{InklayerApiFactory.GitHubWeb}/login/oauth/authorize?", returnTo);
        Assert.Equal(("gh-client", "repo", "S256"), (query["client_id"], query["scope"], query["code_challenge_method"]));
        return await FinishConnectAsync(client, "github", $"code-{login}", query["state"]!);
    }

    /// <summary>"Connect" up to the tracker's page: checks where it goes, and returns that address's query.</summary>
    private static async Task<System.Collections.Specialized.NameValueCollection> StartConnectAsync(HttpClient client, string kind, string authorizePrefix, string returnTo = "/projects/x#issues")
    {
        using var start = await client.GetAsync(new Uri($"/api/me/tracker-accounts/{kind}/connect?returnTo={Uri.EscapeDataString(returnTo)}", UriKind.Relative));
        Assert.Equal(HttpStatusCode.Redirect, start.StatusCode);
        var authorize = start.Headers.Location!;
        Assert.StartsWith(authorizePrefix, authorize.ToString(), StringComparison.Ordinal);
        var query = HttpUtility.ParseQueryString(authorize.Query);
        Assert.Equal("code", query["response_type"]);
        Assert.EndsWith($"/api/me/tracker-accounts/{kind}/callback", query["redirect_uri"], StringComparison.Ordinal);
        return query;
    }

    /// <summary>Back from the tracker with a code; returns where Inklayer sent the browser.</summary>
    private static async Task<string> FinishConnectAsync(HttpClient client, string kind, string code, string state)
    {
        using var back = await client.GetAsync(new Uri($"/api/me/tracker-accounts/{kind}/callback?code={code}&state={Uri.EscapeDataString(state)}", UriKind.Relative));
        Assert.Equal(HttpStatusCode.Redirect, back.StatusCode);
        return back.Headers.Location!.ToString();
    }

    private static async Task<List<TrackerChoiceDto>> ChoicesAsync(HttpClient client, Guid projectId)
    {
        using var response = await client.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/choices", UriKind.Relative));
        return await response.ReadAsync<List<TrackerChoiceDto>>();
    }

    private static string TokenOf(HttpRequestMessage request) => request.Headers.Authorization!.Parameter!;

    [Fact]
    public async Task People_act_in_GitHub_as_their_own_accounts_with_the_shared_one_as_a_fallback()
    {
        InstallGitHubOAuth();
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var projectId = (await Scenario.CreateProjectAsync(admin, org.Id)).Id;
        var (ana, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var (bob, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        using var _a = admin;
        using var _b = ana;
        using var _c = bob;

        var repoName = $"shop{Guid.NewGuid():N}"[..12];
        var repo = $"{InklayerApiFactory.GitHubApi}/repos/acme/{repoName}";
        var issueState = "open";
        factory.Outbound.Responders[repo] = (_, _) => Json(new { full_name = $"acme/{repoName}" });
        factory.Outbound.Responders[$"{repo}/issues"] = (_, _) => Json(new { number = 42, html_url = $"https://github.com/acme/{repoName}/issues/42" }, HttpStatusCode.Created);
        factory.Outbound.Responders[$"{repo}/issues/42"] = (request, _) =>
        {
            if (request.Method == HttpMethod.Patch)
            {
                issueState = "closed";
            }

            return TokenOf(request) == "gho_revoked" ? new HttpResponseMessage(HttpStatusCode.Unauthorized) : Json(new { number = 42, state = issueState });
        };
        factory.Outbound.Responders[$"{repo}/issues/42/comments"] = (request, _) =>
            request.Method == HttpMethod.Post ? Json(new { id = Random.Shared.Next(1, int.MaxValue) }, HttpStatusCode.Created) : Json(Array.Empty<object>());
        var connect = new { kind = "github", settings = new { owner = "acme", repo = repoName, apiUrl = InklayerApiFactory.GitHubApi } };

        // Without a shared token, the admin's own account checks the repository: they connect it first.
        await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", connect).ExpectAsync(HttpStatusCode.BadRequest);
        Assert.Equal("/projects/x#issues", await ConnectAccountAsync(admin, "boss"));
        using (var accounts = await admin.GetAsync(new Uri("/api/me/tracker-accounts", UriKind.Relative)))
        {
            var account = Assert.Single(await accounts.ReadAsync<List<TrackerAccountDto>>(), a => a.Kind == "github");
            Assert.Equal(("github", "boss", $"{InklayerApiFactory.GitHubWeb}/boss"), (account.Kind, account.Login, account.Url));
        }

        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", connect);
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        Assert.Null(tracker.TokenHint);
        Assert.Contains("\"personalAccounts\":true", await created.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        Assert.Equal("gho_boss", TokenOf(factory.Outbound.To(repo).Last().Request));
        await admin.PatchJsonAsync($"/api/projects/{projectId}/issue-trackers/{tracker.Id}", new { postRepliesToIssue = true }).ExpectAsync(HttpStatusCode.OK);

        // Ana hasn't connected, and there's no shared account: she's asked to connect.
        var commentId = await CommentAsync(ana, projectId, "Pay button does nothing");
        var before = Assert.Single(await ChoicesAsync(ana, projectId));
        Assert.Equal(("connect", (string?)null), (before.PostsAs, before.Login));
        await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Conflict);

        // Connected, the issue is hers, and so are her replies on it, without "via Inklayer" naming her.
        await ConnectAccountAsync(ana, "ana");
        var after = Assert.Single(await ChoicesAsync(ana, projectId));
        Assert.Equal(("you", "ana"), (after.PostsAs, after.Login));
        using (var made = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id }))
        {
            Assert.Equal(HttpStatusCode.Created, made.StatusCode);
        }

        Assert.Equal("gho_ana", TokenOf(factory.Outbound.To($"{repo}/issues").Single(r => r.Request.Method == HttpMethod.Post).Request));
        await ana.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = "Only on Safari" }).ExpectAsync(HttpStatusCode.Created);
        var (mine, mineBody) = factory.Outbound.To($"{repo}/issues/42/comments").Last(r => r.Request.Method == HttpMethod.Post);
        Assert.Equal("gho_ana", TokenOf(mine));
        Assert.StartsWith("Only on Safari", JsonDocument.Parse(mineBody).RootElement.GetProperty("body").GetString(), StringComparison.Ordinal);

        // Bob has no account: his reply stays in Inklayer, until an admin adds a shared account, which then posts it with his name.
        var posts = PostsTo($"{repo}/issues/42/comments");
        await bob.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = "Same on Firefox" }).ExpectAsync(HttpStatusCode.Created);
        Assert.Equal(posts, PostsTo($"{repo}/issues/42/comments"));
        using (var shared = await admin.PatchJsonAsync($"/api/projects/{projectId}/issue-trackers/{tracker.Id}", new { token = "ghp_shared9999" }))
        {
            Assert.Equal("…9999", (await shared.ReadAsync<TrackerDto>()).TokenHint);
        }

        Assert.Equal("shared", Assert.Single(await ChoicesAsync(bob, projectId)).PostsAs);
        await bob.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = "And Edge" }).ExpectAsync(HttpStatusCode.Created);
        var (theirs, theirsBody) = factory.Outbound.To($"{repo}/issues/42/comments").Last(r => r.Request.Method == HttpMethod.Post);
        Assert.Equal("ghp_shared9999", TokenOf(theirs));
        Assert.Contains("(via Inklayer): And Edge", JsonDocument.Parse(theirsBody).RootElement.GetProperty("body").GetString(), StringComparison.Ordinal);

        // Checking the issue uses the shared account; without it, the account of whoever made the issue.
        var issueId = (await CommentJsonAsync(ana, commentId)).GetProperty("issues")[0].GetProperty("id").GetGuid();
        await SyncAsync(issueId);
        Assert.Equal("ghp_shared9999", TokenOf(factory.Outbound.To($"{repo}/issues/42").Last(r => r.Request.Method == HttpMethod.Get).Request));
        await admin.PatchJsonAsync($"/api/projects/{projectId}/issue-trackers/{tracker.Id}", new { removeToken = true }).ExpectAsync(HttpStatusCode.OK);
        await SyncAsync(issueId);
        Assert.Equal("gho_ana", TokenOf(factory.Outbound.To($"{repo}/issues/42").Last(r => r.Request.Method == HttpMethod.Get).Request));

        // Ana disconnects: the grant is revoked in GitHub too, and checks fall back to whoever connected the tracker.
        await ana.DeleteAsync(new Uri("/api/me/tracker-accounts/github", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        Assert.Contains(factory.Outbound.To($"{InklayerApiFactory.GitHubApi}/applications/gh-client/grant"), r => r.Body.Contains("gho_ana", StringComparison.Ordinal));
        Assert.Equal("connect", Assert.Single(await ChoicesAsync(ana, projectId)).PostsAs);
        await SyncAsync(issueId);
        Assert.Equal("gho_boss", TokenOf(factory.Outbound.To($"{repo}/issues/42").Last(r => r.Request.Method == HttpMethod.Get).Request));

        // Resolving closes the issue as whoever resolved it.
        await ConnectAccountAsync(ana, "ana");
        await ana.PatchJsonAsync($"/api/annotations/{commentId}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal("gho_ana", TokenOf(factory.Outbound.To($"{repo}/issues/42").Single(r => r.Request.Method == HttpMethod.Patch).Request));

        // A token GitHub no longer accepts is forgotten, so its owner is asked to connect again.
        await ConnectAccountAsync(admin, "revoked");
        await ana.DeleteAsync(new Uri("/api/me/tracker-accounts/github", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        await SyncAsync(issueId);
        using (var accounts = await admin.GetAsync(new Uri("/api/me/tracker-accounts", UriKind.Relative)))
        {
            Assert.Null(Assert.Single(await accounts.ReadAsync<List<TrackerAccountDto>>(), a => a.Kind == "github").Login);
        }
    }

    [Fact]
    public async Task Connecting_an_account_only_finishes_in_the_browser_that_started_it()
    {
        InstallGitHubOAuth();
        using var admin = await factory.SignInAsAdminAsync();
        using var other = await factory.SignInAsAdminAsync();

        // Only paths on this server are returned to.
        using (var start = await admin.GetAsync(new Uri("/api/me/tracker-accounts/github/connect?returnTo=https://evil.example/", UriKind.Relative)))
        {
            var state = HttpUtility.ParseQueryString(start.Headers.Location!.Query)["state"]!;

            // Another browser (no cookie from the start) can't finish it.
            using var stolen = await other.GetAsync(new Uri($"/api/me/tracker-accounts/github/callback?code=code-mallory&state={Uri.EscapeDataString(state)}", UriKind.Relative));
            Assert.StartsWith("/?trackerAccountError=", stolen.Headers.Location!.ToString(), StringComparison.Ordinal);
            Assert.EndsWith("#tracker-accounts", stolen.Headers.Location!.ToString(), StringComparison.Ordinal);

            // Declined in GitHub.
            using var declined = await admin.GetAsync(new Uri($"/api/me/tracker-accounts/github/callback?error=access_denied&state={Uri.EscapeDataString(state)}", UriKind.Relative));
            Assert.Contains("declined", HttpUtility.UrlDecode(declined.Headers.Location!.ToString()), StringComparison.Ordinal);
        }

        // A made-up state.
        using var forged = await admin.GetAsync(new Uri("/api/me/tracker-accounts/github/callback?code=code-x&state=nonsense", UriKind.Relative));
        Assert.Contains("trackerAccountError=", forged.Headers.Location!.ToString(), StringComparison.Ordinal);
        using var accounts = await admin.GetAsync(new Uri("/api/me/tracker-accounts", UriKind.Relative));
        Assert.DoesNotContain(await accounts.ReadAsync<List<TrackerAccountDto>>(), a => a.Login == "mallory" || a.Login == "x");
    }
}
