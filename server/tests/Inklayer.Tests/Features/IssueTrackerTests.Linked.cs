using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

public sealed record FoundIssueDto(string ExternalId, string Key, string Title, string Url, string State);

/// <summary>Linking issues that already exist, bringing their comments into the thread, and posting replies back.</summary>
public sealed partial class IssueTrackerTests
{
    /// <summary>A GitHub repository with issue #7, whose comments a test can add to; comments posted to it are listed too.</summary>
    private sealed class FakeGitHubIssue
    {
        public required string Api { get; init; }

        public string Repo => $"{Api}/repos/acme/shop";

        public string State { get; set; } = "open";

        public ConcurrentQueue<object> Comments { get; } = new();

        private int nextId = 900;

        public void Add(string login, string body, string at) =>
            Comments.Enqueue(new { id = Interlocked.Increment(ref nextId), user = new { login, html_url = $"https://github.com/{login}" }, body, created_at = at, updated_at = at });

        public void Install(InklayerApiFactory factory)
        {
            var issue = () => new { number = 7, title = "Checkout is slow", html_url = "https://github.com/acme/shop/issues/7", state = State };
            factory.Outbound.Responders[Repo] = (_, _) => Json(new { full_name = "acme/shop" });
            factory.Outbound.Responders[$"{Api}/search/issues"] = (_, _) => Json(new { items = new[] { issue() } });
            factory.Outbound.Responders[$"{Repo}/issues/7"] = (request, body) =>
            {
                if (request.Method == HttpMethod.Patch)
                {
                    State = "closed";
                }

                return Json(issue());
            };
            factory.Outbound.Responders[$"{Repo}/issues/7/comments"] = (request, body) =>
            {
                if (request.Method != HttpMethod.Post)
                {
                    return Json(Comments.ToArray());
                }

                var id = Interlocked.Increment(ref nextId);
                var text = JsonDocument.Parse(body).RootElement.GetProperty("body").GetString();
                Comments.Enqueue(new { id, user = new { login = "inklayer-bot", html_url = "https://github.com/inklayer-bot" }, body = text, created_at = "2099-01-01T00:00:00Z", updated_at = "2099-01-01T00:00:00Z" });
                return Json(new { id }, HttpStatusCode.Created);
            };
        }
    }

    private async Task<TrackerDto> ConnectGitHubAsync(HttpClient admin, Guid projectId, FakeGitHubIssue fake)
    {
        fake.Install(factory);
        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "github", token = "ghp_token", settings = new { owner = "acme", repo = "shop", apiUrl = fake.Api } });
        return await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
    }

    private int PostsTo(string url) => factory.Outbound.To(url).Count(r => r.Request.Method == HttpMethod.Post);

    [Fact]
    public async Task An_existing_issue_is_linked_and_its_comments_follow_the_thread()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var fake = new FakeGitHubIssue { Api = $"https://gh-{Guid.NewGuid():N}.test" };
        fake.Add("sam", "Seen this before the redesign", "2000-01-01T00:00:00Z");
        var tracker = await ConnectGitHubAsync(admin, projectId, fake);
        var commentId = await CommentAsync(ana, projectId, "Checkout takes ages");

        // Search by title, or find by address; another repository's address is refused.
        using (var search = await ana.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/{tracker.Id}/search?q=slow", UriKind.Relative)))
        {
            var found = Assert.Single(await search.ReadAsync<List<FoundIssueDto>>());
            Assert.Equal(("#7", "Checkout is slow", "open"), (found.Key, found.Title, found.State));
        }

        using (var other = await ana.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/{tracker.Id}/search?q={Uri.EscapeDataString("https://github.com/other/repo/issues/7")}", UriKind.Relative)))
        {
            Assert.Equal(HttpStatusCode.BadRequest, other.StatusCode);
        }

        await viewer.PostJsonAsync($"/api/annotations/{commentId}/issues/link", new { connectionId = tracker.Id, reference = "#7" }).ExpectAsync(HttpStatusCode.Forbidden);
        using var linked = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues/link", new { connectionId = tracker.Id, reference = "https://github.com/acme/shop/issues/7" });
        var issue = await linked.ReadAsync<IssueDto>(HttpStatusCode.Created);
        Assert.Equal(("#7", "open"), (issue.Key, issue.State));
        await ana.PostJsonAsync($"/api/annotations/{commentId}/issues/link", new { connectionId = tracker.Id, reference = "7" }).ExpectAsync(HttpStatusCode.Conflict);

        // The comment went onto the issue, with its page.
        var note = JsonDocument.Parse(factory.Outbound.To($"{fake.Repo}/issues/7/comments").Single(r => r.Request.Method == HttpMethod.Post).Body)
            .RootElement.GetProperty("body").GetString()!;
        Assert.StartsWith("**Linked from Inklayer**", note, StringComparison.Ordinal);
        Assert.Contains("Checkout takes ages", note, StringComparison.Ordinal);

        // What was said before linking shows in the thread, without the note Inklayer posted, and without notifying anyone.
        var thread = (await CommentJsonAsync(ana, commentId)).GetProperty("issueComments");
        var earlier = Assert.Single(thread.EnumerateArray());
        Assert.Equal(("sam", "Seen this before the redesign", "#7"), (earlier.GetProperty("authorName").GetString(), earlier.GetProperty("body").GetString(), earlier.GetProperty("issueKey").GetString()));

        // A follow-up in GitHub arrives with the next sync, and the comment's author hears about it.
        fake.Add("sam", "Which browser?", "2099-01-02T00:00:00Z");
        await SyncAsync(issue.Id);
        thread = (await CommentJsonAsync(ana, commentId)).GetProperty("issueComments");
        Assert.Equal(["Seen this before the redesign", "Which browser?"], thread.EnumerateArray().Select(c => c.GetProperty("body").GetString()));
        using (var inbox = await ana.GetAsync(new Uri("/api/notifications", UriKind.Relative)))
        {
            var item = Assert.Single((await inbox.ReadAsync<InboxDto>()).Items, i => i.Kind == "issue_comment");
            Assert.Equal(("sam on GitHub #7: Which browser?", commentId), (item.Preview, item.AnnotationId));
        }

        // Replies stay in Inklayer until the tracker is set to post them.
        await ana.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = "Safari 17" }).ExpectAsync(HttpStatusCode.Created);
        Assert.Equal(1, PostsTo($"{fake.Repo}/issues/7/comments"));

        await admin.PatchJsonAsync($"/api/projects/{projectId}/issue-trackers/{tracker.Id}", new { postRepliesToIssue = true }).ExpectAsync(HttpStatusCode.OK);
        await ana.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = "Also Chrome" }).ExpectAsync(HttpStatusCode.Created);
        Assert.Equal(2, PostsTo($"{fake.Repo}/issues/7/comments"));
        var posted = JsonDocument.Parse(factory.Outbound.To($"{fake.Repo}/issues/7/comments").Last(r => r.Request.Method == HttpMethod.Post).Body)
            .RootElement.GetProperty("body").GetString()!;
        Assert.Contains("(via Inklayer): Also Chrome", posted, StringComparison.Ordinal);

        // What Inklayer posted isn't brought back as GitHub's.
        await SyncAsync(issue.Id);
        Assert.Equal(2, (await CommentJsonAsync(ana, commentId)).GetProperty("issueComments").GetArrayLength());
    }

    [Fact]
    public async Task An_issue_shared_by_several_comments_closes_with_the_last_of_them()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var fake = new FakeGitHubIssue { Api = $"https://gh-{Guid.NewGuid():N}.test" };
        var tracker = await ConnectGitHubAsync(admin, projectId, fake);
        var first = await CommentAsync(ana, projectId, "Slow on the cart");
        var second = await CommentAsync(ana, projectId, "Slow on payment too");
        foreach (var id in new[] { first, second })
        {
            await ana.PostJsonAsync($"/api/annotations/{id}/issues/link", new { connectionId = tracker.Id, reference = "#7", addComment = false })
                .ExpectAsync(HttpStatusCode.Created);
        }

        Assert.Equal(0, PostsTo($"{fake.Repo}/issues/7/comments"));
        int Closes() => factory.Outbound.To($"{fake.Repo}/issues/7").Count(r => r.Request.Method == HttpMethod.Patch);

        await ana.PatchJsonAsync($"/api/annotations/{first}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal(0, Closes());
        await ana.PatchJsonAsync($"/api/annotations/{second}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal(1, Closes());
    }

    [Fact]
    public async Task Comments_from_GitLab_Jira_and_Azure_DevOps_come_in_as_plain_text()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var commentId = await CommentAsync(ana, projectId, "Logo overlaps the menu");

        async Task<Guid> ConnectAsync(object body)
        {
            using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", body);
            return (await created.ReadAsync<TrackerDto>(HttpStatusCode.Created)).Id;
        }

        async Task LinkAsync(Guid trackerId, string reference, HttpStatusCode expected = HttpStatusCode.Created) =>
            await ana.PostJsonAsync($"/api/annotations/{commentId}/issues/link", new { connectionId = trackerId, reference, addComment = false }).ExpectAsync(expected);

        // GitLab: people's notes, not system ones.
        var gitlab = $"https://gitlab-{Guid.NewGuid():N}.test";
        var project = $"{gitlab}/api/v4/projects/acme%2Fshop";
        factory.Outbound.Responders[project] = (_, _) => Json(new { issues_enabled = true });
        factory.Outbound.Responders[$"{project}/issues/3"] = (_, _) => Json(new { iid = 3, title = "Logo", web_url = $"{gitlab}/acme/shop/-/issues/3", state = "opened" });
        factory.Outbound.Responders[$"{project}/issues/3/notes"] = (_, _) => Json(new object[]
        {
            new { id = 1, system = true, body = "changed the description", author = new { name = "Lee" }, created_at = "2000-01-01T00:00:00Z", updated_at = "2000-01-01T00:00:00Z" },
            new { id = 2, system = false, body = "Fixed on main", author = new { name = "Lee", web_url = $"{gitlab}/lee" }, created_at = "2000-01-02T00:00:00Z", updated_at = "2000-01-02T00:00:00Z" },
        });
        var gitlabId = await ConnectAsync(new { kind = "gitlab", token = "glpat", settings = new { site = gitlab, projectKey = "acme/shop" } });
        await LinkAsync(gitlabId, $"{gitlab}/acme/shop/-/issues/3");

        // Jira: Atlassian Document Format flattened; keys from other projects refused.
        var jira = $"https://jira-{Guid.NewGuid():N}.test";
        factory.Outbound.Responders[$"{jira}/rest/api/3/project/ABC"] = (_, _) => Json(new { key = "ABC" });
        factory.Outbound.Responders[$"{jira}/rest/api/3/issue/ABC-9"] = (_, _) =>
            Json(new { key = "ABC-9", fields = new { summary = "Logo", status = new { statusCategory = new { key = "indeterminate" } } } });
        factory.Outbound.Responders[$"{jira}/rest/api/3/issue/ABC-9/comment"] = (_, _) => Json(new
        {
            comments = new[]
            {
                new
                {
                    id = "100", author = new { displayName = "Kim" }, created = "2000-01-03T00:00:00.000+0000", updated = "2000-01-03T00:00:00.000+0000",
                    body = new
                    {
                        type = "doc", version = 1,
                        content = new object[]
                        {
                            new { type = "paragraph", content = new object[] { new { type = "text", text = "Needs " }, new { type = "text", text = "design" } } },
                            new { type = "paragraph", content = new object[] { new { type = "mention", attrs = new { text = "@Ana" } } } },
                        },
                    },
                },
            },
        });
        var jiraId = await ConnectAsync(new { kind = "jira", token = "atl", settings = new { site = jira, projectKey = "ABC", email = "bot@acme.test" } });
        await LinkAsync(jiraId, "XYZ-9", HttpStatusCode.BadRequest);
        await LinkAsync(jiraId, $"{jira}/browse/ABC-9");

        // Azure DevOps: HTML to text; work items from other projects refused.
        var org = $"https://ado-{Guid.NewGuid():N}.test/acme";
        var ado = $"{org}/Shop";
        factory.Outbound.Responders[$"{ado}/_apis/wit/workitemtypes/Bug?"] = (_, _) => Json(new { name = "Bug" });
        factory.Outbound.Responders[$"{ado}/_apis/wit/workitemtypes/Bug/states"] = (_, _) => Json(new { value = new[] { new { name = "Active", category = "InProgress" } } });
        factory.Outbound.Responders[$"{ado}/_apis/wit/workitems/55"] = (_, _) => Json(new
        {
            id = 55, fields = new Dictionary<string, string> { ["System.Title"] = "Logo", ["System.State"] = "Active", ["System.WorkItemType"] = "Bug", ["System.TeamProject"] = "Shop" },
        });
        factory.Outbound.Responders[$"{ado}/_apis/wit/workitems/56"] = (_, _) => Json(new
        {
            id = 56, fields = new Dictionary<string, string> { ["System.Title"] = "Other", ["System.State"] = "Active", ["System.WorkItemType"] = "Bug", ["System.TeamProject"] = "Payments" },
        });
        factory.Outbound.Responders[$"{ado}/_apis/wit/workItems/55/comments"] = (_, _) => Json(new
        {
            comments = new[] { new { id = 7, text = "<div>Repro on <b>Edge</b> &amp; Firefox</div><div>Thanks</div>", createdBy = new { displayName = "Jo" }, createdDate = "2000-01-04T00:00:00Z" } },
        });
        var adoId = await ConnectAsync(new { kind = "azuredevops", token = "pat", settings = new { site = org, projectKey = "Shop" } });
        await LinkAsync(adoId, "#56", HttpStatusCode.BadRequest);
        await LinkAsync(adoId, $"{ado}/_workitems/edit/55");

        var thread = (await CommentJsonAsync(ana, commentId)).GetProperty("issueComments").EnumerateArray()
            .Select(c => (c.GetProperty("kind").GetString(), c.GetProperty("authorName").GetString(), c.GetProperty("body").GetString())).ToList();
        Assert.Equal(
            [("gitlab", "Lee", "Fixed on main"), ("jira", "Kim", "Needs design\n@Ana"), ("azuredevops", "Jo", "Repro on Edge & Firefox\nThanks")],
            thread);
    }
}
