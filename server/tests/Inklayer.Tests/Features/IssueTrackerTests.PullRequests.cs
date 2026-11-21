using System.Net;
using System.Text.Json;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

/// <summary>Pull requests (GitLab: merge requests) linked to comments: finding them, the summary kept on them, and merging.</summary>
public sealed partial class IssueTrackerTests
{
    /// <summary>A tracker's pull request #12, faked: its state is <c>merged</c>; summary comments get ids from 500.</summary>
    private sealed class FakePulls
    {
        public required string Kind { get; init; }
        public required object Settings { get; init; }
        public required string Url { get; init; }
        public required string Key { get; init; }
        public required string CommentsUrl { get; init; }
        public bool Merged { get; set; }
    }

    private FakePulls InstallPulls(string kind)
    {
        var r = factory.Outbound.Responders;
        var nextId = 500;
        string NewId() => Interlocked.Increment(ref nextId).ToString(System.Globalization.CultureInfo.InvariantCulture);
        FakePulls fake;
        switch (kind)
        {
            case "github":
            {
                const string Repo = "https://api.github.com/repos/acme/prs";
                fake = new FakePulls
                {
                    Kind = kind, Settings = new { owner = "acme", repo = "prs" }, Url = "https://github.com/acme/prs/pull/12", Key = "PR #12", CommentsUrl = $"{Repo}/issues/",
                };
                var f = fake;
                r[Repo] = (_, _) => Json(new { has_issues = true, permissions = new { push = true } });
                object Pull() => new { number = 12, title = "Fix checkout", html_url = f.Url, state = f.Merged ? "closed" : "open", merged_at = f.Merged ? "2026-11-21T00:00:00Z" : null };
                r[$"{Repo}/pulls/12"] = (_, _) => Json(Pull());
                r[$"{Repo}/pulls?"] = (_, _) => Json(new[] { Pull() });
                r[$"{Repo}/issues/12/comments"] = (_, _) => Json(new { id = long.Parse(NewId(), System.Globalization.CultureInfo.InvariantCulture) }, HttpStatusCode.Created);
                r[$"{Repo}/issues/comments/"] = (_, _) => Json(new { });
                break;
            }

            case "gitlab":
            {
                const string Project = "https://gitlab.com/api/v4/projects/acme%2Fprs";
                fake = new FakePulls
                {
                    Kind = kind, Settings = new { projectKey = "acme/prs" }, Url = "https://gitlab.com/acme/prs/-/merge_requests/12", Key = "!12", CommentsUrl = $"{Project}/merge_requests/12/notes",
                };
                var f = fake;
                r[Project] = (_, _) => Json(new { issues_enabled = true });
                object Merge() => new { iid = 12, title = "Fix checkout", web_url = f.Url, state = f.Merged ? "merged" : "opened" };
                r[$"{Project}/merge_requests/12"] = (_, _) => Json(Merge());
                r[$"{Project}/merge_requests?"] = (_, _) => Json(new[] { Merge() });
                r[$"{Project}/merge_requests/12/notes"] = (req, _) => req.Method == HttpMethod.Post
                    ? Json(new { id = long.Parse(NewId(), System.Globalization.CultureInfo.InvariantCulture) }, HttpStatusCode.Created)
                    : Json(new { });
                break;
            }

            case "forgejo":
            {
                const string Repo = "https://codeberg.org/api/v1/repos/acme/prs";
                fake = new FakePulls
                {
                    Kind = kind, Settings = new { owner = "acme", repo = "prs" }, Url = "https://codeberg.org/acme/prs/pulls/12", Key = "PR #12", CommentsUrl = $"{Repo}/issues/",
                };
                var f = fake;
                r[Repo] = (_, _) => Json(new { has_issues = true });
                object Pull() => new { number = 12, title = "Fix checkout", html_url = f.Url, state = f.Merged ? "closed" : "open", merged = f.Merged };
                r[$"{Repo}/pulls/12"] = (_, _) => Json(Pull());
                r[$"{Repo}/issues?"] = (_, _) => Json(new[] { new { number = 12, title = "Fix checkout", html_url = f.Url, state = "open", pull_request = new { merged = false } } });
                r[$"{Repo}/issues/12/comments"] = (_, _) => Json(new { id = long.Parse(NewId(), System.Globalization.CultureInfo.InvariantCulture) }, HttpStatusCode.Created);
                r[$"{Repo}/issues/comments/"] = (_, _) => Json(new { });
                break;
            }

            default:
            {
                const string Project = "https://dev.azure.com/prs/Shop";
                fake = new FakePulls
                {
                    Kind = kind, Settings = new { site = "https://dev.azure.com/prs", projectKey = "Shop" }, Url = $"{Project}/_git/shop-web/pullrequest/12", Key = "!12",
                    CommentsUrl = $"{Project}/_apis/git/repositories/repo-1/pullRequests/12/threads",
                };
                var f = fake;
                r[$"{Project}/_apis/wit/workitemtypes/Bug"] = (_, _) => Json(new { name = "Bug" });
                object Pull() => new
                {
                    pullRequestId = 12, title = "Fix checkout", status = f.Merged ? "completed" : "active",
                    repository = new { id = "repo-1", name = "shop-web", project = new { name = "Shop" } },
                };
                r[$"{Project}/_apis/git/pullrequests/12"] = (_, _) => Json(Pull());
                r[$"{Project}/_apis/git/pullrequests?"] = (_, _) => Json(new { value = new[] { Pull() } });
                r[$"{Project}/_apis/git/repositories/repo-1/pullRequests/12/threads"] = (req, _) => req.Method == HttpMethod.Post
                    ? Json(new { id = long.Parse(NewId(), System.Globalization.CultureInfo.InvariantCulture) })
                    : Json(new { });
                break;
            }
        }

        return fake;
    }

    [Theory]
    [InlineData("github")]
    [InlineData("gitlab")]
    [InlineData("forgejo")]
    [InlineData("azuredevops")]
    public async Task Pull_requests_are_linked_summarised_and_resolve_their_comments_when_merged(string kind)
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var fake = InstallPulls(kind);
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind, token = "shared-token", settings = fake.Settings });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        using (var choices = await ana.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/choices", UriKind.Relative)))
        {
            Assert.Contains("\"pullRequests\":true", await choices.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        // Found by searching pull requests, and by its address.
        using (var found = await ana.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/{tracker.Id}/search?q=&pullRequests=true", UriKind.Relative)))
        {
            Assert.Equal(fake.Key, Assert.Single(await found.ReadAsync<List<IssueDto>>()).Key);
        }

        var first = await CommentAsync(ana, projectId, "Total is wrong after a coupon");
        var second = await CommentAsync(ana, projectId, "Coupon field too narrow");
        using (var linked = await ana.PostJsonAsync($"/api/annotations/{first}/issues/link", new { connectionId = tracker.Id, reference = fake.Url, pullRequest = true }))
        {
            var pr = await linked.ReadAsync<IssueDto>(HttpStatusCode.Created);
            Assert.Equal((fake.Key, "open"), (pr.Key, pr.State));
        }

        Assert.Contains("\"pullRequest\":true", (await CommentJsonAsync(ana, first)).GetRawText(), StringComparison.Ordinal);
        await ana.PostJsonAsync($"/api/annotations/{first}/issues/link", new { connectionId = tracker.Id, reference = fake.Url, pullRequest = true })
            .ExpectAsync(HttpStatusCode.Conflict);

        // One summary on the pull request, listing the comment; the second is linked without being listed.
        string Summary(int index)
        {
            var posts = factory.Outbound.To(fake.CommentsUrl).Where(x => x.Request.Method != HttpMethod.Get).ToList();
            var body = JsonDocument.Parse(posts[index].Body).RootElement;
            return kind == "azuredevops"
                ? body.TryGetProperty("comments", out var comments) ? comments[0].GetProperty("content").GetString()! : body.GetProperty("content").GetString()!
                : body.GetProperty("body").GetString()!;
        }

        int Sent() => factory.Outbound.To(fake.CommentsUrl).Count(x => x.Request.Method != HttpMethod.Get);
        Assert.Equal(1, Sent());
        Assert.Contains("🔵 Open: **Total is wrong after a coupon**", Summary(0), StringComparison.Ordinal);
        Assert.Equal(HttpMethod.Post, factory.Outbound.To(fake.CommentsUrl).Last().Request.Method);
        await ana.PostJsonAsync($"/api/annotations/{second}/issues/link", new { connectionId = tracker.Id, reference = "12", pullRequest = true, addComment = false })
            .ExpectAsync(HttpStatusCode.Created);
        Assert.Equal(1, Sent());

        // Next time, it's offered before searching: recent, with its title, and not twice.
        using (var again = await admin.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/{tracker.Id}/search?q=&pullRequests=true", UriKind.Relative)))
        {
            var offered = JsonDocument.Parse(await again.Content.ReadAsStringAsync()).RootElement;
            var only = Assert.Single(offered.EnumerateArray());
            Assert.Equal((fake.Key, "Fix checkout", true), (only.GetProperty("key").GetString(), only.GetProperty("title").GetString(), only.GetProperty("recent").GetBoolean()));
        }

        // Issues have their own recent list: the pull request isn't in it.
        using (var issuesOffered = await admin.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/{tracker.Id}/search?q=", UriKind.Relative)))
        {
            Assert.DoesNotContain("\"recent\":true", await issuesOffered.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        // The extension learns the pull request's address, and on its page shows the comments linked to it.
        using (var urls = await viewer.GetAsync(new Uri("/api/live/pull-requests", UriKind.Relative)))
        {
            Assert.Contains(fake.Url, await urls.ReadAsync<List<string>>());
        }

        using (var page = await viewer.GetAsync(new Uri($"/api/live/pull-request?url={Uri.EscapeDataString(fake.Url)}", UriKind.Relative)))
        {
            var pr = JsonDocument.Parse(await page.Content.ReadAsStringAsync()).RootElement;
            Assert.Equal(HttpStatusCode.OK, page.StatusCode);
            Assert.Equal(fake.Key, pr.GetProperty("key").GetString());
            Assert.Equal(["Total is wrong after a coupon", "Coupon field too narrow"], pr.GetProperty("comments").EnumerateArray().Select(c => c.GetProperty("body").GetString()));
        }

        await viewer.GetAsync(new Uri("/api/live/pull-request?url=https%3A%2F%2Fgithub.com%2Fother%2Frepo%2Fpull%2F1", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        // Resolving the comment edits the summary, and leaves the pull request alone.
        await ana.PatchJsonAsync($"/api/annotations/{first}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal(2, Sent());
        Assert.Contains("✅ Resolved: **Total is wrong after a coupon**", Summary(1), StringComparison.Ordinal);
        Assert.NotEqual(HttpMethod.Post, factory.Outbound.To(fake.CommentsUrl).Last().Request.Method);
        await ana.PatchJsonAsync($"/api/annotations/{first}", new { version = 2, status = "Open" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal(3, Sent());
        Assert.Contains("🔵 Open", Summary(2), StringComparison.Ordinal);

        // Merged: both comments are resolved, and the summary says so.
        fake.Merged = true;
        foreach (var id in await PullRequestLinksAsync(fake.Key))
        {
            await SyncAsync(id);
        }

        foreach (var comment in new[] { first, second })
        {
            var json = await CommentJsonAsync(ana, comment);
            Assert.Equal("Resolved", json.GetProperty("status").GetString());
            Assert.Contains($"Merged in", json.GetRawText(), StringComparison.Ordinal);
        }

        Assert.Contains("✅ Resolved", Summary(Sent() - 1), StringComparison.Ordinal);
        Assert.Contains("\"state\":\"merged\"", (await CommentJsonAsync(ana, first)).GetRawText(), StringComparison.Ordinal);
    }

    private async Task<List<Guid>> PullRequestLinksAsync(string key)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<Inklayer.Infrastructure.Persistence.InklayerDbContext>();
        return await db.AnnotationIssues.Where(i => i.PullRequest && i.Key == key && i.State == "open").Select(i => i.Id).ToListAsync();
    }

    [Fact]
    public async Task Jira_and_Linear_have_no_pull_requests_and_issue_links_refuse_pull_requests()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Site = "https://nopr.atlassian.net";
        factory.Outbound.Responders[$"{Site}/rest/api/3/project/WEB"] = (_, _) => Json(new { key = "WEB" });
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "jira", token = "t", settings = new { site = Site, projectKey = "WEB", email = "bot@acme.test" } });
        var jira = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var comment = await CommentAsync(ana, projectId, "Needs a PR");
        await ana.PostJsonAsync($"/api/annotations/{comment}/issues/link", new { connectionId = jira.Id, reference = "WEB-1", pullRequest = true })
            .ExpectAsync(HttpStatusCode.BadRequest);

        // A pull request's address isn't an issue.
        var fake = InstallPulls("github");
        using var gh = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "github", token = "ghp", settings = fake.Settings });
        var github = await gh.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        await ana.PostJsonAsync($"/api/annotations/{comment}/issues/link", new { connectionId = github.Id, reference = fake.Url }).ExpectAsync(HttpStatusCode.BadRequest);
    }
}
