using System.Net;
using System.Text;
using System.Text.Json;
using Inklayer.Api.Features.Issues;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record TrackerDto(Guid Id, string Kind, string Name, bool CloseIssueOnResolve, string TokenHint, string? LastError);

public sealed record PageSummaryDto(string PageUrl, int OpenCount, int ResolvedCount, Guid ProjectId, string ProjectName, string OrganizationName, int IssueCount, int OpenIssueCount);

public sealed record IssueDto(Guid Id, string Kind, string Key, string Url, string State);

/// <summary>GitHub, GitLab, Forgejo, Jira Cloud, Linear and Azure DevOps, each against a fake tracker: connecting, creating issues, and keeping both sides in step.</summary>
[Collection(ApiTestGroup.Name)]
public sealed partial class IssueTrackerTests(InklayerApiFactory factory)
{
    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    private async Task<(HttpClient Admin, Guid ProjectId, HttpClient Ana, MeDto AnaMe, HttpClient Viewer)> ProjectAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (ana, anaMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        return (admin, project.Id, ana, anaMe, viewer);
    }

    private static async Task<Guid> CommentAsync(HttpClient client, Guid projectId, string body)
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations", new
        {
            url = "https://shop.example/checkout", kind = "Pin", body,
            anchor = new { element = new { path = new[] { "h1" }, tag = "h1" } }, geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } }, viewportWidth = 1200,
        });
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return json.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task<JsonElement> CommentJsonAsync(HttpClient client, Guid id)
    {
        using var response = await client.GetAsync(new Uri($"/api/annotations/{id}", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
    }

    /// <summary>Makes the issue due for the next sync and runs it.</summary>
    private async Task SyncAsync(Guid issueId)
    {
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            await db.AnnotationIssues.Where(i => i.Id == issueId).ExecuteUpdateAsync(u => u.SetProperty(i => i.LastSyncedAt, DateTime.UnixEpoch));
        }

        await factory.Services.GetRequiredService<IssueSyncService>().RunOnceAsync(CancellationToken.None);
    }

    [Fact]
    public async Task GitHub_issues_carry_the_comment_and_close_when_it_is_resolved()
    {
        var (admin, projectId, ana, anaMe, viewer) = await ProjectAsync();
        using var _ = admin;
        using var __ = ana;
        using var ___ = viewer;
        var api = $"https://gh-{Guid.NewGuid():N}.test";
        factory.Outbound.Responders[$"{api}/repos/acme/shop/issues"] = (request, _) => request.Method == HttpMethod.Post
            ? Json(new { number = 42, html_url = "https://github.com/acme/shop/issues/42" }, HttpStatusCode.Created)
            : Json(new { state = "closed" });
        factory.Outbound.Responders[$"{api}/repos/acme/shop"] = (_, _) => Json(new { full_name = "acme/shop" });

        // Only project Admins connect trackers.
        var connect = new { kind = "github", token = "ghp_secret1234", settings = new { owner = "acme", repo = "shop", apiUrl = api } };
        await ana.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", connect).ExpectAsync(HttpStatusCode.Forbidden);
        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", connect);
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        Assert.Equal(("acme/shop", "…1234", true), (tracker.Name, tracker.TokenHint, tracker.CloseIssueOnResolve));
        Assert.DoesNotContain("ghp_secret", await created.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        // Commenters see what they can pick, without settings.
        using var choices = await ana.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers/choices", UriKind.Relative));
        Assert.Equal([tracker.Id], (await choices.ReadAsync<List<TrackerDto>>()).Select(t => t.Id));

        var commentId = await CommentAsync(ana, projectId, $"Pay button does nothing <@{anaMe.Id}>");
        await admin.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = "Happens on Safari too" }).ExpectAsync(HttpStatusCode.Created);
        await viewer.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Forbidden);

        using var made = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id });
        var issue = await made.ReadAsync<IssueDto>(HttpStatusCode.Created);
        Assert.Equal(("github", "#42", "open"), (issue.Kind, issue.Key, issue.State));

        var (request, body) = factory.Outbound.To($"{api}/repos/acme/shop/issues").Single(r => r.Request.Method == HttpMethod.Post);
        Assert.Equal("Bearer", request.Headers.Authorization!.Scheme);
        using var sent = JsonDocument.Parse(body);
        Assert.Equal($"Pay button does nothing @{anaMe.DisplayName}", sent.RootElement.GetProperty("title").GetString());
        var markdown = sent.RootElement.GetProperty("body").GetString()!;
        Assert.Contains("**Page:** [https://shop.example/checkout](https://shop.example/checkout)", markdown, StringComparison.Ordinal);
        Assert.Contains($"/comments/{commentId}", markdown, StringComparison.Ordinal);
        Assert.Contains(": Happens on Safari too", markdown, StringComparison.Ordinal);

        var comment = await CommentJsonAsync(ana, commentId);
        var chip = Assert.Single(comment.GetProperty("issues").EnumerateArray());
        Assert.Equal("#42", chip.GetProperty("key").GetString());

        // Resolved here: closed there.
        await ana.PatchJsonAsync($"/api/annotations/{commentId}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        var (close, closeBody) = factory.Outbound.To($"{api}/repos/acme/shop/issues/42").Single(r => r.Request.Method == HttpMethod.Patch);
        Assert.Contains("\"state\":\"closed\"", closeBody, StringComparison.Ordinal);
        Assert.Equal("closed", (await CommentJsonAsync(ana, commentId)).GetProperty("issues")[0].GetProperty("state").GetString());

        // The pages list counts the page's issues.
        using var pages = await ana.GetAsync(new Uri("/api/live/pages", UriKind.Relative));
        var page = Assert.Single(await pages.ReadAsync<List<PageSummaryDto>>());
        Assert.Equal(("https://shop.example/checkout", 0, 1, 1, 0), (page.PageUrl, page.OpenCount, page.ResolvedCount, page.IssueCount, page.OpenIssueCount));
    }

    [Fact]
    public async Task The_pages_list_covers_every_project_you_can_see_and_no_others()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var org = await Scenario.CreateOrganizationAsync(admin);
        var second = await Scenario.CreateProjectAsync(admin, org.Id);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        using var _d = outsider;
        await CommentAsync(ana, projectId, "One");
        await CommentAsync(ana, projectId, "Two");
        await CommentAsync(outsider, second.Id, "Elsewhere");

        using var mine = await viewer.GetAsync(new Uri("/api/live/pages", UriKind.Relative));
        var page = Assert.Single(await mine.ReadAsync<List<PageSummaryDto>>());
        Assert.Equal((projectId, 2, 0), (page.ProjectId, page.OpenCount, page.IssueCount));
        Assert.False(string.IsNullOrEmpty(page.ProjectName));
        using var theirs = await outsider.GetAsync(new Uri("/api/live/pages", UriKind.Relative));
        Assert.Equal([second.Id], (await theirs.ReadAsync<List<PageSummaryDto>>()).Select(p => p.ProjectId));
    }

    [Fact]
    public async Task A_tracker_that_refuses_the_token_is_not_saved()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var api = $"https://gh-{Guid.NewGuid():N}.test";
        factory.Outbound.Responders[api] = (_, _) => Json(new { message = "Bad credentials" }, HttpStatusCode.Unauthorized);

        using var response = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "github", token = "nope", settings = new { owner = "acme", repo = "shop", apiUrl = api } });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("refused the token", await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "jira", token = "t", settings = new { site = "http://insecure.test", projectKey = "ABC", email = "a@b.test" } }).ExpectAsync(HttpStatusCode.BadRequest);

        using var list = await admin.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers", UriKind.Relative));
        Assert.Empty(await list.ReadAsync<List<TrackerDto>>());
    }

    [Fact]
    public async Task Jira_issues_closed_or_reopened_there_resolve_or_reopen_the_comment()
    {
        var (admin, projectId, ana, anaMe, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var site = $"https://jira-{Guid.NewGuid():N}.test";
        var status = "indeterminate";
        factory.Outbound.Responders[$"{site}/rest/api/3/project/ABC"] = (_, _) => Json(new { key = "ABC" });
        factory.Outbound.Responders[$"{site}/rest/api/3/issue"] = (request, _) => request.Method == HttpMethod.Post
            ? Json(new { id = "10001", key = "ABC-7" }, HttpStatusCode.Created)
            : Json(new { fields = new { status = new { statusCategory = new { key = status } } } });

        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "jira", token = "atl-token", settings = new { site, projectKey = "ABC", email = "bot@acme.test" } });
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var authorization = factory.Outbound.To($"{site}/rest/api/3/project/ABC").Last().Request.Headers.Authorization!;
        Assert.Equal(("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes("bot@acme.test:atl-token"))), (authorization.Scheme, authorization.Parameter));

        var commentId = await CommentAsync(ana, projectId, "Totals are wrong");
        using var made = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id, title = "Checkout totals" });
        var issue = await made.ReadAsync<IssueDto>(HttpStatusCode.Created);
        Assert.Equal(("ABC-7", $"{site}/browse/ABC-7"), (issue.Key, issue.Url));
        using (var sent = JsonDocument.Parse(factory.Outbound.To($"{site}/rest/api/3/issue").Single(r => r.Request.Method == HttpMethod.Post).Body))
        {
            var fields = sent.RootElement.GetProperty("fields");
            Assert.Equal(("Checkout totals", "Bug", "doc"), (fields.GetProperty("summary").GetString(), fields.GetProperty("issuetype").GetProperty("name").GetString(),
                fields.GetProperty("description").GetProperty("type").GetString()));
        }

        await SyncAsync(issue.Id); // still in progress: nothing changes
        Assert.Equal("Open", (await CommentJsonAsync(ana, commentId)).GetProperty("status").GetString());

        status = "done";
        await SyncAsync(issue.Id);
        var resolved = await CommentJsonAsync(ana, commentId);
        Assert.Equal("Resolved", resolved.GetProperty("status").GetString());
        Assert.Equal("Closed in Jira ABC-7.", resolved.GetProperty("replies")[0].GetProperty("body").GetString());
        using (var inbox = await ana.GetAsync(new Uri("/api/notifications", UriKind.Relative)))
        {
            Assert.Contains((await inbox.ReadAsync<InboxDto>()).Items, i => i.Kind == "issue_closed" && i.AnnotationId == commentId);
        }

        status = "new";
        await SyncAsync(issue.Id);
        Assert.Equal("Open", (await CommentJsonAsync(ana, commentId)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Linear_issues_are_created_through_GraphQL()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var teamId = Guid.NewGuid().ToString();
        factory.Outbound.Responders["https://api.linear.app/graphql"] = (_, body) => body.Contains("issueCreate", StringComparison.Ordinal)
            ? Json(new { data = new { issueCreate = new { success = true, issue = new { id = "lin-1", identifier = "ENG-5", url = "https://linear.app/acme/issue/ENG-5" } } } })
            : Json(new { data = new { team = new { id = teamId, name = "Engineering" } } });

        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "linear", token = "lin_api_key", settings = new { teamId }, closeIssueOnResolve = false });
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        Assert.Equal("lin_api_key", factory.Outbound.To("https://api.linear.app/graphql").Last().Request.Headers.GetValues("Authorization").Single());

        var commentId = await CommentAsync(ana, projectId, "Logo is blurry");
        using var made = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id });
        Assert.Equal("ENG-5", (await made.ReadAsync<IssueDto>(HttpStatusCode.Created)).Key);

        // This connection leaves issues open when comments are resolved.
        var before = factory.Outbound.To("https://api.linear.app/graphql").Count();
        await ana.PatchJsonAsync($"/api/annotations/{commentId}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal(before, factory.Outbound.To("https://api.linear.app/graphql").Count());
    }

    [Fact]
    public async Task Azure_DevOps_work_items_follow_their_state_category()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var org = $"https://ado-{Guid.NewGuid():N}.test/acme";
        var project = $"{org}/Web Shop"; // as the fake sees it: Uri.ToString() unescapes %20
        var state = "Active";
        factory.Outbound.Responders[$"{project}/_apis/wit/workitemtypes/Bug?"] = (_, _) => Json(new { name = "Bug" });
        factory.Outbound.Responders[$"{project}/_apis/wit/workitemtypes/Bug/states"] = (_, _) => Json(new
        {
            value = new[] { new { name = "New", category = "Proposed" }, new { name = "Active", category = "InProgress" }, new { name = "Closed", category = "Completed" } },
        });
        factory.Outbound.Responders[$"{project}/_apis/wit/workitems/$Bug"] = (_, _) =>
            Json(new { id = 1234, _links = new { html = new { href = $"{project}/_workitems/edit/1234" } } });
        factory.Outbound.Responders[$"{project}/_apis/wit/workitems/1234"] = (request, body) =>
        {
            if (request.Method == HttpMethod.Patch)
            {
                state = "Closed";
            }

            return Json(new { id = 1234, fields = new Dictionary<string, string> { ["System.WorkItemType"] = "Bug", ["System.State"] = state } });
        };

        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "azuredevops", token = "ado-pat", settings = new { site = org, projectKey = "Web Shop" } });
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var authorization = factory.Outbound.To($"{project}/_apis/wit/workitemtypes/Bug?").Last().Request.Headers.Authorization!;
        Assert.Equal(("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes(":ado-pat"))), (authorization.Scheme, authorization.Parameter));

        var commentId = await CommentAsync(ana, projectId, "Coupon <b>field</b> overlaps");
        using var made = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id, title = "Coupon field" });
        var issue = await made.ReadAsync<IssueDto>(HttpStatusCode.Created);
        Assert.Equal(("#1234", $"{project}/_workitems/edit/1234"), (issue.Key, issue.Url));
        var (post, postBody) = factory.Outbound.To($"{project}/_apis/wit/workitems/$Bug").Single();
        Assert.Equal("application/json-patch+json", post.Content!.Headers.ContentType!.MediaType);
        using (var sent = JsonDocument.Parse(postBody))
        {
            var ops = sent.RootElement.EnumerateArray().ToDictionary(o => o.GetProperty("path").GetString()!, o => o.GetProperty("value").GetString()!);
            Assert.Equal("Coupon field", ops["/fields/System.Title"]);
            Assert.Contains("Coupon &lt;b&gt;field&lt;/b&gt; overlaps", ops["/fields/Microsoft.VSTS.TCM.ReproSteps"], StringComparison.Ordinal);
        }

        await SyncAsync(issue.Id); // Active is in progress: nothing changes
        Assert.Equal("Open", (await CommentJsonAsync(ana, commentId)).GetProperty("status").GetString());

        // Resolving the comment moves the work item to the type's Completed state.
        await ana.PatchJsonAsync($"/api/annotations/{commentId}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        var (_, patchBody) = factory.Outbound.To($"{project}/_apis/wit/workitems/1234").Single(r => r.Request.Method == HttpMethod.Patch);
        using (var sent = JsonDocument.Parse(patchBody))
        {
            Assert.Equal(("/fields/System.State", "Closed"), (sent.RootElement[0].GetProperty("path").GetString(), sent.RootElement[0].GetProperty("value").GetString()));
        }

        // Reopened in Azure DevOps: the comment reopens.
        state = "Active";
        await SyncAsync(issue.Id);
        Assert.Equal("Open", (await CommentJsonAsync(ana, commentId)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task GitLab_issues_use_the_project_path_and_its_iid()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var site = $"https://gitlab-{Guid.NewGuid():N}.test";
        var project = $"{site}/api/v4/projects/acme%2Fweb%2Fshop";
        var state = "opened";
        factory.Outbound.Responders[project] = (request, _) => request.Method == HttpMethod.Get
            ? Json(new { id = 7, path_with_namespace = "acme/web/shop", issues_enabled = true })
            : Json(new { message = "unexpected" }, HttpStatusCode.BadRequest);
        factory.Outbound.Responders[$"{project}/issues"] = (request, _) => request.Method == HttpMethod.Post
            ? Json(new { id = 90001, iid = 12, web_url = $"{site}/acme/web/shop/-/issues/12" }, HttpStatusCode.Created)
            : Json(new { message = "unexpected" }, HttpStatusCode.BadRequest);
        factory.Outbound.Responders[$"{project}/issues/12"] = (request, _) =>
        {
            if (request.Method == HttpMethod.Put)
            {
                state = "closed";
            }

            return Json(new { iid = 12, state });
        };

        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "gitlab", token = "glpat-secret", settings = new { site, projectKey = "acme/web/shop" } });
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        Assert.Equal("glpat-secret", factory.Outbound.To(project).Last().Request.Headers.GetValues("PRIVATE-TOKEN").Single());

        var commentId = await CommentAsync(ana, projectId, "Menu doesn't close");
        using var made = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id, title = "Menu stays open" });
        var issue = await made.ReadAsync<IssueDto>(HttpStatusCode.Created);
        Assert.Equal(("#12", $"{site}/acme/web/shop/-/issues/12"), (issue.Key, issue.Url));
        using (var sent = JsonDocument.Parse(factory.Outbound.To($"{project}/issues").Single(r => r.Request.Method == HttpMethod.Post).Body))
        {
            Assert.Equal("Menu stays open", sent.RootElement.GetProperty("title").GetString());
            Assert.Contains("Menu doesn't close", sent.RootElement.GetProperty("description").GetString(), StringComparison.Ordinal);
        }

        await SyncAsync(issue.Id);
        Assert.Equal("Open", (await CommentJsonAsync(ana, commentId)).GetProperty("status").GetString());

        // Resolving the comment closes the GitLab issue.
        await ana.PatchJsonAsync($"/api/annotations/{commentId}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        var (_, closeBody) = factory.Outbound.To($"{project}/issues/12").Single(r => r.Request.Method == HttpMethod.Put);
        using (var sent = JsonDocument.Parse(closeBody))
        {
            Assert.Equal("close", sent.RootElement.GetProperty("state_event").GetString());
        }

        // Reopened in GitLab: the comment reopens.
        state = "opened";
        await SyncAsync(issue.Id);
        Assert.Equal("Open", (await CommentJsonAsync(ana, commentId)).GetProperty("status").GetString());
    }

    [Fact]
    public async Task Forgejo_issues_go_to_the_instance_given()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var site = $"https://forgejo-{Guid.NewGuid():N}.test";
        var repo = $"{site}/api/v1/repos/acme/shop";
        factory.Outbound.Responders[repo] = (_, _) => Json(new { full_name = "acme/shop", has_issues = true });
        factory.Outbound.Responders[$"{repo}/issues"] = (request, _) => request.Method == HttpMethod.Post
            ? Json(new { number = 3, html_url = $"{site}/acme/shop/issues/3", state = "open" }, HttpStatusCode.Created)
            : Json(new { message = "unexpected" }, HttpStatusCode.BadRequest);

        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "forgejo", token = "fj-token", settings = new { site, owner = "acme", repo = "shop" } });
        var tracker = await created.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var authorization = factory.Outbound.To(repo).Last().Request.Headers.Authorization!;
        Assert.Equal(("token", "fj-token"), (authorization.Scheme, authorization.Parameter));

        var commentId = await CommentAsync(ana, projectId, "Footer overlaps");
        using var made = await ana.PostJsonAsync($"/api/annotations/{commentId}/issues", new { connectionId = tracker.Id });
        var issue = await made.ReadAsync<IssueDto>(HttpStatusCode.Created);
        Assert.Equal(("#3", $"{site}/acme/shop/issues/3"), (issue.Key, issue.Url));
    }

    [Fact]
    public async Task Forgejo_refuses_a_repository_with_issues_turned_off()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var site = $"https://forgejo-{Guid.NewGuid():N}.test";
        factory.Outbound.Responders[$"{site}/api/v1/repos/acme/wiki"] = (_, _) => Json(new { full_name = "acme/wiki", has_issues = false });

        using var created = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "forgejo", token = "fj-token", settings = new { site, owner = "acme", repo = "wiki" } });
        Assert.Equal(HttpStatusCode.BadRequest, created.StatusCode);
        Assert.Contains("Issues are turned off", await created.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }
}
