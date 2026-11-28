using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;
using Inklayer.Api.Features.Kanban;
using Inklayer.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record KanbanSyncResultDto(int Pulled, int Pushed, int Created, string? Error);

public sealed record KanbanTrackerDto(Guid ConnectionId, string Direction, Dictionary<string, string> StatusMap, string? SyncError);

public sealed record KanbanSettingsWithTrackerDto(Guid Id, string KeyPrefix, KanbanTrackerDto? Tracker);

public sealed record KanbanSyncDto(KanbanSettingsWithTrackerDto Settings, KanbanSyncResultDto? Result);

public sealed record KanbanTrackerChoiceDto(Guid ConnectionId, string ProjectName, string? ProjectKey);

/// <summary>A kanban kept in step with a Jira project, against a fake Jira: issues come in as tasks, and changes go both ways.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class KanbanSyncTests(InklayerApiFactory factory)
{
    private static HttpResponseMessage Json(object body, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    /// <summary>A Jira project with three statuses and the issues in <paramref name="issues"/>, which tests change.</summary>
    private static void FakeJira(FakeOutboundHandler outbound, string site, ConcurrentDictionary<string, Dictionary<string, object?>> issues, string benEmail)
    {
        var r = outbound.Responders;
        r[$"{site}/rest/api/3/project/ABC"] = (_, _) => Json(new
        {
            key = "ABC",
            issueTypes = new object[] { new { name = "Task", subtask = false }, new { name = "Bug", subtask = false }, new { name = "Sub-task", subtask = true } },
        });
        r[$"{site}/rest/api/3/project/ABC/statuses"] = (_, _) => Json(new object[]
        {
            new
            {
                name = "Task",
                statuses = new object[]
                {
                    new { id = "1", name = "To Do", statusCategory = new { key = "new" } },
                    new { id = "3", name = "In Progress", statusCategory = new { key = "indeterminate" } },
                    new { id = "5", name = "Done", statusCategory = new { key = "done" } },
                },
            },
        });
        r[$"{site}/rest/api/3/search/jql"] = (_, _) => Json(new { issues = issues.Values.ToArray() });
        r[$"{site}/rest/api/3/user/search"] = (request, _) => request.RequestUri!.Query.Contains(Uri.EscapeDataString(benEmail), StringComparison.Ordinal)
            ? Json(new object[] { new { accountId = "acc-ben", emailAddress = benEmail } })
            : Json(Array.Empty<object>());
        r[$"{site}/rest/api/3/issue"] = (request, _) => request.Method == HttpMethod.Post
            ? Json(new { id = "10002", key = "ABC-2" }, HttpStatusCode.Created)
            : new HttpResponseMessage(HttpStatusCode.NoContent);
        r[$"{site}/rest/api/3/issue/ABC-1?fields=status"] = (_, _) => Json(new { fields = new { status = new { id = "1" } } });
        r[$"{site}/rest/api/3/issue/ABC-2?fields=status"] = (_, _) => Json(new { fields = new { status = new { id = "1" } } });
        r[$"{site}/rest/api/3/issue/ABC-1/transitions"] = (request, _) => request.Method == HttpMethod.Get
            ? Json(new { transitions = new object[] { new { id = "21", to = new { id = "3" } }, new { id = "31", to = new { id = "5" } } } })
            : new HttpResponseMessage(HttpStatusCode.NoContent);
    }

    private static Dictionary<string, object?> Issue(string id, string key, string title, string statusId, string category, string? assignee, string updated) => new()
    {
        ["id"] = id,
        ["key"] = key,
        ["fields"] = new
        {
            summary = title,
            description = new { type = "doc", version = 1, content = new object[] { new { type = "paragraph", content = new object[] { new { type = "text", text = "From Jira" } } } } },
            status = new { id = statusId, statusCategory = new { key = category } },
            assignee = assignee is null ? null : new { accountId = assignee, displayName = "Ben" },
            duedate = "2026-12-24",
            labels = new[] { "UI" },
            priority = new { name = "High" },
            issuetype = new { name = "Task" },
            issuelinks = Array.Empty<object>(),
            updated,
        },
    };

    [Fact]
    public async Task Jira_issues_come_in_as_tasks_and_changes_go_both_ways()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (ben, benMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        using var _ = ben;
        var site = $"https://kanban-{Guid.NewGuid():N}.test";
        var issues = new ConcurrentDictionary<string, Dictionary<string, object?>>();
        issues["ABC-1"] = Issue("10001", "ABC-1", "Fix checkout", "1", "new", "acc-ben", "2026-11-01T10:00:00.000+0000");
        FakeJira(factory.Outbound, site, issues, benMe.Email);

        using var connectionMade = await admin.PostJsonAsync($"/api/projects/{project.Id}/issue-trackers",
            new { kind = "jira", token = "atl-token", settings = new { site, projectKey = "ABC", email = "bot@acme.test" } });
        var connection = await connectionMade.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        using var kanbanMade = await admin.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Checkout", kind = "kanban", keyPrefix = "CO" });
        var kanbanId = (await kanbanMade.ReadAsync<DocSummaryDto>(HttpStatusCode.Created)).Id;

        // The product's Jira connection is offered; connecting brings in the open issues.
        using var choices = await admin.GetAsync(new Uri($"/api/kanbans/{kanbanId}/tracker/choices", UriKind.Relative));
        Assert.Equal(("ABC", connection.Id), (Assert.Single(await choices.ReadAsync<List<KanbanTrackerChoiceDto>>()).ProjectKey, connection.Id));
        using var connected = await admin.PutJsonAsync($"/api/kanbans/{kanbanId}/tracker", new { connectionId = connection.Id });
        var first = await connected.ReadAsync<KanbanSyncDto>();
        Assert.Null(first.Result!.Error);
        Assert.Equal(1, first.Result.Pulled);
        Assert.Equal(3, first.Settings.Tracker!.StatusMap.Count);

        KanbanDoc.Task Task(KanbanDoc.State s, string extKey) => s.Tasks.Values.Single(t => t.ExtKey == extKey);
        async Task<KanbanDoc.State> ReadAsync()
        {
            await using var scope = factory.Services.CreateAsyncScope();
            return (await scope.ServiceProvider.GetRequiredService<KanbanEditor>().ReadAsync(kanbanId, default))!;
        }

        var state = await ReadAsync();
        var task = Task(state, "ABC-1");
        Assert.Equal(("CO-1", "Fix checkout", "From Jira", "To do"), (task.Key, task.Title, task.Description, state.ColumnOf(task)!.Name));
        Assert.Equal([benMe.Id.ToString()], task.Assignees);
        Assert.Equal(["ui"], task.Tags);
        Assert.Equal(("2026-12-24", "high"), (task.Due, task.Priority));

        // Moved here: Jira's issue goes through the transition to In Progress.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<KanbanEditor>().UpdateAsync(kanbanId, benMe.Id, "CO-1", new TaskChange(Column: "In progress"), default);
        }

        using (var synced = await ben.PostJsonAsync($"/api/kanbans/{kanbanId}/tracker/sync", new { }))
        {
            var result = (await synced.ReadAsync<KanbanSyncDto>()).Result!;
            Assert.Null(result.Error);
            Assert.Equal(1, result.Pushed);
        }

        var transition = factory.Outbound.To($"{site}/rest/api/3/issue/ABC-1/transitions").Last(x => x.Request.Method == HttpMethod.Post);
        Assert.Contains("\"21\"", transition.Body, StringComparison.Ordinal);

        // Renamed in Jira (and now In Progress there too): the task follows, and nothing goes back.
        issues["ABC-1"] = Issue("10001", "ABC-1", "Fix the checkout totals", "3", "indeterminate", "acc-ben", "2099-01-01T10:00:00.000+0000");
        var putsBefore = factory.Outbound.To($"{site}/rest/api/3/issue/ABC-1").Count(x => x.Request.Method == HttpMethod.Put);
        using (var synced = await ben.PostJsonAsync($"/api/kanbans/{kanbanId}/tracker/sync", new { }))
        {
            Assert.Equal(0, (await synced.ReadAsync<KanbanSyncDto>()).Result!.Pushed);
        }

        state = await ReadAsync();
        Assert.Equal(("Fix the checkout totals", "In progress"), (Task(state, "ABC-1").Title, state.ColumnOf(Task(state, "ABC-1"))!.Name));
        Assert.Equal(putsBefore, factory.Outbound.To($"{site}/rest/api/3/issue/ABC-1").Count(x => x.Request.Method == HttpMethod.Put));

        // A task added here becomes an issue, with its due date and tags.
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            await scope.ServiceProvider.GetRequiredService<KanbanEditor>().CreateAsync(kanbanId, benMe.Id, new TaskChange("Write release notes", Due: "2026-12-30", Tags: ["docs"]), default);
        }

        using (var synced = await ben.PostJsonAsync($"/api/kanbans/{kanbanId}/tracker/sync", new { }))
        {
            var result = (await synced.ReadAsync<KanbanSyncDto>()).Result!;
            Assert.Null(result.Error);
            Assert.Equal(1, result.Created);
        }

        var made = factory.Outbound.To($"{site}/rest/api/3/issue").Last(x => x.Request.Method == HttpMethod.Post && x.Request.RequestUri!.AbsolutePath == "/rest/api/3/issue");
        Assert.Contains("Write release notes", made.Body, StringComparison.Ordinal);
        var fields = factory.Outbound.To($"{site}/rest/api/3/issue/ABC-2").Last(x => x.Request.Method == HttpMethod.Put).Body;
        Assert.Contains("2026-12-30", fields, StringComparison.Ordinal);
        Assert.Contains("docs", fields, StringComparison.Ordinal);
        state = await ReadAsync();
        Assert.Equal("ABC-2", state.Tasks.Values.Single(t => t.Title == "Write release notes").ExtKey);

        // Disconnected: nothing more is synced, and tasks keep their issues.
        using var disconnected = await admin.DeleteAsync(new Uri($"/api/kanbans/{kanbanId}/tracker", UriKind.Relative));
        Assert.Null((await disconnected.ReadAsync<KanbanSettingsWithTrackerDto>()).Tracker);
        Assert.Equal("ABC-1", Task(await ReadAsync(), "ABC-1").ExtKey);
    }
}
