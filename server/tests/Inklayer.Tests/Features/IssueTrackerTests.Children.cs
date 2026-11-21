using System.Net;
using System.Text.Json;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

/// <summary>Creating an issue under another: Jira sub-tasks (and issues in an epic), Azure DevOps child work items.</summary>
public sealed partial class IssueTrackerTests
{
    [Fact]
    public async Task Jira_issues_are_created_as_sub_tasks_or_in_an_epic_under_a_chosen_parent()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Site = "https://children.atlassian.net";
        var r = factory.Outbound.Responders;
        r[$"{Site}/rest/api/3/project/WEB"] = (_, _) => Json(new
        {
            key = "WEB",
            issueTypes = new object[] { new { name = "Task", subtask = false }, new { name = "Bug", subtask = false }, new { name = "Sub-task", subtask = true } },
        });
        // WEB-1 an ordinary task, WEB-2 an epic, WEB-3 a sub-task.
        foreach (var (key, type, level, subtask) in new[] { ("WEB-1", "Task", 0, false), ("WEB-2", "Epic", 1, false), ("WEB-3", "Sub-task", -1, true) })
        {
            r[$"{Site}/rest/api/3/issue/{key}?fields=summary"] = (_, _) => Json(new { key, fields = new { summary = $"{type} {key}", status = new { statusCategory = new { key = "new" } } } });
            r[$"{Site}/rest/api/3/issue/{key}?fields=issuetype"] = (_, _) => Json(new { key, fields = new { issuetype = new { name = type, subtask, hierarchyLevel = level } } });
        }

        var created = 10;
        r[$"{Site}/rest/api/3/issue"] = (request, _) => request.Method == HttpMethod.Post
            ? Json(new { key = $"WEB-{Interlocked.Increment(ref created)}" }, HttpStatusCode.Created)
            : Json(new { }, HttpStatusCode.NotFound);

        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "jira", token = "api-token", settings = new { site = Site, projectKey = "WEB", email = "bot@acme.test" } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);

        JsonElement LastFields() => JsonDocument.Parse(factory.Outbound.To($"{Site}/rest/api/3/issue").Last(x => x.Request.Method == HttpMethod.Post && x.Request.RequestUri!.AbsolutePath == "/rest/api/3/issue").Body)
            .RootElement.GetProperty("fields");

        // Under a task, by its address: a sub-task, in the project's sub-task type.
        var first = await CommentAsync(ana, projectId, "Price wraps on mobile");
        using (var made = await ana.PostJsonAsync($"/api/annotations/{first}/issues", new { connectionId = tracker.Id, parent = $"{Site}/browse/WEB-1" }))
        {
            Assert.Equal("WEB-11", (await made.ReadAsync<IssueDto>(HttpStatusCode.Created)).Key);
        }

        var fields = LastFields();
        Assert.Equal(("Sub-task", "WEB-1"), (fields.GetProperty("issuetype").GetProperty("name").GetString(), fields.GetProperty("parent").GetProperty("key").GetString()));

        // Under an epic: an issue of the tracker's type (Bug), in the epic.
        var second = await CommentAsync(ana, projectId, "Footer overlaps");
        await ana.PostJsonAsync($"/api/annotations/{second}/issues", new { connectionId = tracker.Id, parent = "WEB-2" }).ExpectAsync(HttpStatusCode.Created);
        fields = LastFields();
        Assert.Equal(("Bug", "WEB-2"), (fields.GetProperty("issuetype").GetProperty("name").GetString(), fields.GetProperty("parent").GetProperty("key").GetString()));

        // Not under a sub-task, nor an issue of another project; and without a parent, an ordinary issue.
        var third = await CommentAsync(ana, projectId, "Menu flickers");
        using (var refused = await ana.PostJsonAsync($"/api/annotations/{third}/issues", new { connectionId = tracker.Id, parent = "WEB-3" }))
        {
            Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
            Assert.Contains("sub-task itself", await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        await ana.PostJsonAsync($"/api/annotations/{third}/issues", new { connectionId = tracker.Id, parent = "OPS-4" }).ExpectAsync(HttpStatusCode.BadGateway);
        await ana.PostJsonAsync($"/api/annotations/{third}/issues", new { connectionId = tracker.Id, parent = " " }).ExpectAsync(HttpStatusCode.Created);
        Assert.False(LastFields().TryGetProperty("parent", out _));
    }

    [Fact]
    public async Task Azure_DevOps_work_items_are_created_as_children_and_other_trackers_refuse_a_parent()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Org = "https://dev.azure.com/children";
        const string Project = $"{Org}/Shop";
        var r = factory.Outbound.Responders;
        r[$"{Project}/_apis/wit/workitemtypes/Issue"] = (_, _) => Json(new
        {
            name = "Issue", value = new[] { new { name = "To Do", category = "Proposed" }, new { name = "Done", category = "Completed" } },
        });
        r[$"{Project}/_apis/wit/workitems/7?"] = (_, _) => Json(new
        {
            id = 7, fields = new Dictionary<string, string> { ["System.Title"] = "Checkout epic", ["System.State"] = "To Do", ["System.WorkItemType"] = "Epic", ["System.TeamProject"] = "Shop" },
        });
        r[$"{Project}/_apis/wit/workitemtypes/Epic/states"] = (_, _) => Json(new { value = new[] { new { name = "To Do", category = "Proposed" } } });
        r[$"{Project}/_apis/wit/workitems/$Issue"] = (_, _) => Json(new { id = 8 });

        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers",
            new { kind = "azuredevops", token = "pat", settings = new { site = Org, projectKey = "Shop", issueType = "Issue" } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);

        var comment = await CommentAsync(ana, projectId, "Coupon field overlaps");
        using (var made = await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id, parent = "#7" }))
        {
            Assert.Equal("#8", (await made.ReadAsync<IssueDto>(HttpStatusCode.Created)).Key);
        }

        using (var sent = JsonDocument.Parse(factory.Outbound.To($"{Project}/_apis/wit/workitems/$Issue").Single().Body))
        {
            var relation = sent.RootElement.EnumerateArray().Single(o => o.GetProperty("path").GetString() == "/relations/-").GetProperty("value");
            Assert.Equal("System.LinkTypes.Hierarchy-Reverse", relation.GetProperty("rel").GetString());
            Assert.Equal($"{Org}/_apis/wit/workItems/7", relation.GetProperty("url").GetString());
        }

        // GitHub has no sub-issues here: asking for a parent is refused, and nothing is created.
        const string Repo = "https://api.github.com/repos/acme/children";
        r[Repo] = (_, _) => Json(new { has_issues = true, permissions = new { push = true } });
        using var github = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "github", token = "ghp_x", settings = new { owner = "acme", repo = "children" } });
        var gh = await github.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        using var refused = await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = gh.Id, parent = "#1" });
        Assert.Equal(HttpStatusCode.BadGateway, refused.StatusCode);
        Assert.DoesNotContain(factory.Outbound.To($"{Repo}/issues"), x => x.Request.Method == HttpMethod.Post);
    }
}
