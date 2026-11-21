using System.Net;
using System.Text.Json;
using System.Web;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

/// <summary>Own accounts in GitLab, Forgejo, Linear, Jira and Azure DevOps: connecting, acting as them, and refreshing their tokens.</summary>
public sealed partial class IssueTrackerTests
{
    /// <summary>A tracker's OAuth and API, faked: where people allow Inklayer, the token endpoint, who the account is, and the issue calls.</summary>
    private sealed record FakeTracker(string Kind, string AuthorizePrefix, string TokenUrl, object Settings, string IssuesUrl);

    /// <summary>A value from a token request's body, which is a form, or JSON for Atlassian.</summary>
    private static string? Field(string body, string name)
    {
        if (body.StartsWith('{'))
        {
            return JsonDocument.Parse(body).RootElement.TryGetProperty(name, out var value) ? value.GetString() : null;
        }

        return HttpUtility.ParseQueryString(body)[name];
    }

    private FakeTracker InstallTracker(string kind)
    {
        const string Gitlab = InklayerApiFactory.GitLabUrl;
        const string Forgejo = InklayerApiFactory.ForgejoUrl;
        const string Jira = "https://acme-oauth.atlassian.net";
        const string Ado = "https://dev.azure.com/acme-oauth";
        var r = factory.Outbound.Responders;
        FakeTracker fake;
        switch (kind)
        {
            case "gitlab":
                fake = new FakeTracker(kind, $"{Gitlab}/oauth/authorize?", $"{Gitlab}/oauth/token", new { site = Gitlab, projectKey = "acme/shop" },
                    $"{Gitlab}/api/v4/projects/acme%2Fshop/issues");
                r[$"{Gitlab}/api/v4/user"] = (_, _) => Json(new { id = 5, username = "ana", web_url = $"{Gitlab}/ana" });
                r[$"{Gitlab}/api/v4/projects/acme%2Fshop"] = (_, _) => Json(new { issues_enabled = true });
                r[fake.IssuesUrl] = (_, _) => Json(new { iid = 3, web_url = $"{Gitlab}/acme/shop/-/issues/3" }, HttpStatusCode.Created);
                r[$"{Gitlab}/oauth/revoke"] = (_, _) => Json(new { });
                break;
            case "forgejo":
                fake = new FakeTracker(kind, $"{Forgejo}/login/oauth/authorize?", $"{Forgejo}/login/oauth/access_token",
                    new { site = Forgejo, owner = "acme", repo = "shop" }, $"{Forgejo}/api/v1/repos/acme/shop/issues");
                r[$"{Forgejo}/api/v1/user"] = (_, _) => Json(new { id = 6, login = "ana" });
                r[$"{Forgejo}/api/v1/repos/acme/shop"] = (_, _) => Json(new { has_issues = true });
                r[fake.IssuesUrl] = (_, _) => Json(new { number = 3, html_url = $"{Forgejo}/acme/shop/issues/3" }, HttpStatusCode.Created);
                break;
            case "linear":
                fake = new FakeTracker(kind, "https://linear.app/oauth/authorize?", "https://api.linear.app/oauth/token", new { teamId = "team-1" },
                    "https://api.linear.app/graphql");
                r["https://api.linear.app/graphql"] = (_, body) => body.Contains("viewer", StringComparison.Ordinal)
                    ? Json(new { data = new { viewer = new { id = "user-1", displayName = "ana", url = "https://linear.app/acme/profiles/ana" } } })
                    : body.Contains("issueCreate", StringComparison.Ordinal)
                        ? Json(new { data = new { issueCreate = new { success = true, issue = new { id = "issue-3", identifier = "ENG-3", url = "https://linear.app/acme/issue/ENG-3" } } } })
                        : Json(new { data = new { team = new { id = "team-1", name = "Engineering" } } });
                r["https://api.linear.app/oauth/revoke"] = (_, _) => Json(new { });
                break;
            case "jira":
                // Own accounts go through Atlassian's gateway for the site, not the site itself.
                fake = new FakeTracker(kind, "https://auth.atlassian.com/authorize?", "https://auth.atlassian.com/oauth/token",
                    new { site = Jira, projectKey = "WEB", email = "bot@acme.test" }, "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue");
                r["https://api.atlassian.com/me"] = (_, _) => Json(new { account_id = "acc-1", name = "ana" });
                r["https://api.atlassian.com/oauth/token/accessible-resources"] = (_, _) => Json(new[] { new { id = "cloud-1", url = Jira, name = "acme" } });
                r[$"{Jira}/rest/api/3/project/WEB"] = (_, _) => Json(new { key = "WEB" });
                r[fake.IssuesUrl] = (_, _) => Json(new { key = "WEB-3" }, HttpStatusCode.Created);
                break;
            default:
                fake = new FakeTracker(kind, "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?",
                    "https://login.microsoftonline.com/organizations/oauth2/v2.0/token", new { site = Ado, projectKey = "Web" }, $"{Ado}/Web/_apis/wit/workitems/");
                r["https://app.vssps.visualstudio.com/_apis/profile/profiles/me"] = (_, _) => Json(new { id = "ado-1", emailAddress = "ana@acme.test", displayName = "Ana" });
                r[$"{Ado}/Web/_apis/wit/workitemtypes/Bug"] = (_, _) => Json(new { name = "Bug" });
                r[fake.IssuesUrl] = (_, _) => Json(new { id = 3 });
                break;
        }

        // Codes and refresh tokens become numbered access tokens; "dead" refresh tokens are refused.
        var issued = 0;
        r[fake.TokenUrl] = (_, body) =>
        {
            Assert.Equal(kind is "gitlab" ? "gl-secret" : kind is "forgejo" ? "fj-secret" : kind is "linear" ? "ln-secret" : kind is "jira" ? "at-secret" : "az-secret",
                Field(body, "client_secret"));
            if (Field(body, "grant_type") == "refresh_token" && Field(body, "refresh_token") == "dead")
            {
                return Json(new { error = "invalid_grant" }, HttpStatusCode.BadRequest);
            }

            if (kind is "gitlab" && Field(body, "grant_type") == "refresh_token")
            {
                Assert.EndsWith("/api/me/tracker-accounts/gitlab/callback", Field(body, "redirect_uri"), StringComparison.Ordinal);
            }

            var n = Interlocked.Increment(ref issued);
            return Json(new { access_token = $"at-{kind}-{n}", refresh_token = $"rt-{kind}-{n}", expires_in = 3600, token_type = "Bearer" });
        };
        return fake;
    }

    [Theory]
    [InlineData("gitlab")]
    [InlineData("forgejo")]
    [InlineData("linear")]
    [InlineData("jira")]
    [InlineData("azuredevops")]
    public async Task People_act_as_their_own_accounts_in_every_tracker_and_tokens_are_refreshed(string kind)
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var projectId = (await Scenario.CreateProjectAsync(admin, org.Id)).Id;
        var (ana, anaMe) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        using var _a = admin;
        using var _b = ana;
        var fake = InstallTracker(kind);

        // Connected with a shared token, which is then removed: everyone acts as themselves.
        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind, token = "shared-token", settings = fake.Settings });
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        Assert.Contains("\"personalAccounts\":true", await created.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        await admin.PatchJsonAsync($"/api/projects/{projectId}/issue-trackers/{tracker.Id}", new { removeToken = true }).ExpectAsync(HttpStatusCode.OK);
        var first = await CommentAsync(ana, projectId, "Logo is blurry");
        await ana.PostJsonAsync($"/api/annotations/{first}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Conflict);

        // Ana connects: the tracker's page, then back with a code.
        var query = await StartConnectAsync(ana, kind, fake.AuthorizePrefix);
        Assert.Equal(kind is "jira" ? null : "S256", query["code_challenge_method"]);
        if (kind is "jira")
        {
            Assert.Equal("api.atlassian.com", query["audience"]);
            Assert.Contains("offline_access", query["scope"], StringComparison.Ordinal);
        }

        Assert.Equal("/projects/x#issues", await FinishConnectAsync(ana, kind, "the-code", query["state"]!));
        using (var accounts = await ana.GetAsync(new Uri("/api/me/tracker-accounts", UriKind.Relative)))
        {
            var account = Assert.Single(await accounts.ReadAsync<List<TrackerAccountDto>>(), a => a.Kind == kind);
            Assert.Equal(kind is "azuredevops" ? "ana@acme.test" : "ana", account.Login);
        }

        Assert.Equal("you", Assert.Single(await ChoicesAsync(ana, projectId)).PostsAs);

        // Her issue is created with her token, as a bearer token.
        string LastIssueToken()
        {
            var request = factory.Outbound.To(fake.IssuesUrl).Last(x => x.Request.Method == HttpMethod.Post).Request;
            Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
            return request.Headers.Authorization.Parameter!;
        }

        await ana.PostJsonAsync($"/api/annotations/{first}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        Assert.Equal($"at-{kind}-1", LastIssueToken());

        // Replies posted as her own account end with a link back: small print only where the tracker renders markdown's HTML.
        await admin.PatchJsonAsync($"/api/projects/{projectId}/issue-trackers/{tracker.Id}", new { postRepliesToIssue = true }).ExpectAsync(HttpStatusCode.OK);
        var before = factory.Outbound.Requests.Count;
        await ana.PostJsonAsync($"/api/annotations/{first}/replies", new { body = "Still blurry on retina" }).ExpectAsync(HttpStatusCode.Created);
        var posted = Assert.Single(factory.Outbound.Requests.Skip(before), r => r.Body.Contains("View in Inklayer", StringComparison.Ordinal)).Body;
        var small = System.Text.RegularExpressions.Regex.IsMatch(posted, @"sub(>|&gt;|\\u003E)");
        Assert.Equal(kind is not ("azuredevops" or "jira"), small);

        // An expiring token is refreshed first.
        async Task ExpireAsync(string? refreshToken = null)
        {
            await using var scope = factory.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            var secrets = scope.ServiceProvider.GetRequiredService<Inklayer.Api.Features.Notifications.IntegrationSecrets>();
            var account = await db.TrackerAccounts.SingleAsync(a => a.UserId == anaMe.Id && a.Kind == kind);
            account.ExpiresAt = DateTime.UtcNow.AddSeconds(30);
            if (refreshToken is not null)
            {
                account.ProtectedRefreshToken = secrets.Protect(refreshToken);
            }

            await db.SaveChangesAsync();
        }

        await ExpireAsync();
        var second = await CommentAsync(ana, projectId, "Menu overlaps the logo");
        await ana.PostJsonAsync($"/api/annotations/{second}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        Assert.Equal($"at-{kind}-2", LastIssueToken());

        // A refresh token that stopped working: the account is forgotten, and she's asked to connect again.
        await ExpireAsync("dead");
        var third = await CommentAsync(ana, projectId, "Footer is cut off");
        await ana.PostJsonAsync($"/api/annotations/{third}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Conflict);
        Assert.Equal("connect", Assert.Single(await ChoicesAsync(ana, projectId)).PostsAs);
    }
}
