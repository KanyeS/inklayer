using System.Net;
using Inklayer.Api.Features.Kanban;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using YDotNet.Document.Options;

namespace Inklayer.Tests.Features;

public sealed record ReservedKeysDto(string Prefix, long First, int Count);

public sealed record KanbanSettingsDto(Guid Id, string KeyPrefix, bool CanManage);

public sealed record TaskPersonDto(Guid Id, string DisplayName);

public sealed record TaskMentionDto(Guid DocId, string Title);

public sealed record BacklinksDto(List<DocSummaryDto> Backlinks);

public sealed record TaskSummaryDto(
    Guid KanbanId, string TaskId, string Key, string Title, string Column, string Category, string? Due, List<TaskPersonDto> Assignees, List<string> Tags,
    string? ParentTaskId);

/// <summary>
/// Kanbans are docs of kind "kanban": columns and tasks in their Yjs document, which the server reads with each snapshot to keep
/// an index of tasks for "My tasks", reminders and links from docs. Task keys (WEB-12) are handed out by the server.
/// </summary>
[Collection(ApiTestGroup.Name)]
public sealed class KanbanTests(InklayerApiFactory factory)
{
    private async Task<(HttpClient Admin, Guid OrgId, HttpClient Ana, Guid AnaId, HttpClient Ben, Guid BenId, Guid KanbanId)> KanbanAsync(string? prefix = null)
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (ana, anaMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (ben, benMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        using var created = await ana.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Web Platform", kind = "kanban", keyPrefix = prefix });
        var kanban = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        return (admin, org.Id, ana, anaMe.Id, ben, benMe.Id, kanban.Id);
    }

    /// <summary>A kanban's Yjs state with the default columns and these tasks, built the way the server writes them.</summary>
    private static byte[] State(params KanbanDoc.Task[] tasks)
    {
        using var ydoc = new YDotNet.Document.Doc(new DocOptions { Encoding = DocEncoding.Utf16 });
        var state = KanbanDoc.Read(ydoc);
        var columns = KanbanDoc.EnsureColumns(ydoc, state);
        foreach (var task in tasks)
        {
            task.Column = task.Column.Length == 0 ? columns[0].Id : columns.Single(c => c.Name == task.Column).Id;
            task.Rank = Ranks.Between(null, null);
            KanbanDoc.Insert(ydoc, task);
        }

        using var read = ydoc.ReadTransaction();
        return read.StateDiffV1(null!);
    }

    private async Task SaveAsync(HttpClient client, Guid kanbanId, byte[] state)
    {
        await using var live = await DocsProbe.ConnectAsync(factory, client);
        await live.OpenAsync(kanbanId);
        var seq = await live.UpdateAsync(kanbanId, state);
        Assert.True(await live.SnapshotAsync(kanbanId, state, "summary", seq));
    }

    [Fact]
    public async Task A_kanban_gets_a_key_prefix_from_its_title_unique_in_the_organisation()
    {
        var (admin, orgId, ana, _, ben, _, kanbanId) = await KanbanAsync();
        using var settings = await ana.GetAsync(new Uri($"/api/kanbans/{kanbanId}/settings", UriKind.Relative));
        Assert.Equal("WP", (await settings.ReadAsync<KanbanSettingsDto>()).KeyPrefix);

        // The same words again: a number after it.
        using var second = await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Web platform 2", folder = "Old", kind = "kanban" });
        var secondId = (await second.ReadAsync<DocSummaryDto>(HttpStatusCode.Created)).Id;
        using var secondSettings = await ana.GetAsync(new Uri($"/api/kanbans/{secondId}/settings", UriKind.Relative));
        Assert.Equal("WP2", (await secondSettings.ReadAsync<KanbanSettingsDto>()).KeyPrefix);

        // Chosen, it must be free and well-formed.
        await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Another", kind = "kanban", keyPrefix = "WP" }).ExpectAsync(HttpStatusCode.Conflict);
        await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Another", kind = "kanban", keyPrefix = "9x" }).ExpectAsync(HttpStatusCode.BadRequest);
        using var renamed = await ben.PutJsonAsync($"/api/kanbans/{kanbanId}/settings", new { keyPrefix = "web" });
        Assert.Equal("WEB", (await renamed.ReadAsync<KanbanSettingsDto>()).KeyPrefix);
        await ben.PutJsonAsync($"/api/kanbans/{secondId}/settings", new { keyPrefix = "WEB" }).ExpectAsync(HttpStatusCode.Conflict);

        // Only kanbans have kanban settings.
        using var doc = await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Plain" });
        var docId = (await doc.ReadAsync<DocSummaryDto>(HttpStatusCode.Created)).Id;
        await ana.GetAsync(new Uri($"/api/kanbans/{docId}/settings", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
    }

    [Fact]
    public async Task Keys_reserved_at_the_same_time_are_never_the_same()
    {
        var (admin, orgId, ana, _, ben, _, kanbanId) = await KanbanAsync("KEYS" + Random.Shared.Next(100, 999));
        var reservations = await Task.WhenAll(Enumerable.Range(0, 12).Select(async i =>
        {
            using var response = await (i % 2 == 0 ? ana : ben).PostJsonAsync($"/api/kanbans/{kanbanId}/keys", new { count = 3 });
            return await response.ReadAsync<ReservedKeysDto>();
        }));
        var numbers = reservations.SelectMany(r => Enumerable.Range(0, r.Count).Select(n => r.First + n)).ToList();
        Assert.Equal(36, numbers.Distinct().Count());
        Assert.Equal(1, numbers.Min());

        // Viewers read, and don't add tasks.
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, orgId, "Viewer");
        await viewer.PostJsonAsync($"/api/kanbans/{kanbanId}/keys", new { count = 1 }).ExpectAsync(HttpStatusCode.Forbidden);
        await ana.PostJsonAsync($"/api/kanbans/{kanbanId}/keys", new { count = 500 }).ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Saved_tasks_are_indexed_for_my_tasks_and_new_assignees_are_told()
    {
        var (admin, orgId, ana, anaId, ben, benId, kanbanId) = await KanbanAsync();
        var parent = new KanbanDoc.Task
        {
            Id = "t1", Key = "WP-1", Title = "Launch the site", Assignees = [benId.ToString()], Tags = ["launch", "Web"], Due = "2026-12-01", Priority = "high",
        };
        var child = new KanbanDoc.Task { Id = "t2", Key = "WP-2", Title = "Write the copy", Parent = "t1", Assignees = [anaId.ToString()], Column = "Done" };
        await SaveAsync(ana, kanbanId, State(parent, child));

        using var mine = await ben.GetAsync(new Uri($"/api/orgs/{orgId}/tasks?assignee=me", UriKind.Relative));
        var task = Assert.Single(await mine.ReadAsync<List<TaskSummaryDto>>());
        Assert.Equal(("WP-1", "Launch the site", "To do", "todo", "2026-12-01"), (task.Key, task.Title, task.Column, task.Category, task.Due));
        Assert.Equal(["launch", "web"], task.Tags);
        Assert.Equal(benId, Assert.Single(task.Assignees).Id);

        // Done tasks aren't open; sub-tasks know their parent.
        using var anas = await ana.GetAsync(new Uri($"/api/orgs/{orgId}/tasks?assignee=me", UriKind.Relative));
        Assert.Empty(await anas.ReadAsync<List<TaskSummaryDto>>());
        using var done = await ana.GetAsync(new Uri($"/api/orgs/{orgId}/tasks?assignee=me&status=done", UriKind.Relative));
        Assert.Equal("t1", Assert.Single(await done.ReadAsync<List<TaskSummaryDto>>()).ParentTaskId);
        using var tagged = await ana.GetAsync(new Uri($"/api/orgs/{orgId}/tasks?tag=launch", UriKind.Relative));
        Assert.Single(await tagged.ReadAsync<List<TaskSummaryDto>>());

        // By key, for [[task:WP-1]] in docs.
        using var byKey = await ana.GetAsync(new Uri($"/api/orgs/{orgId}/tasks/wp-1", UriKind.Relative));
        Assert.Equal("t1", (await byKey.ReadAsync<TaskSummaryDto>()).TaskId);
        await ana.GetAsync(new Uri($"/api/orgs/{orgId}/tasks/WP-99", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        // Ben was assigned by Ana: he's told. Ana assigned herself: she isn't.
        using var inbox = await ben.GetAsync(new Uri("/api/notifications", UriKind.Relative));
        var told = Assert.Single((await inbox.ReadAsync<InboxDto>()).Items, i => i.Kind == "task_assigned");
        Assert.Equal(kanbanId, told.DocId);
        Assert.StartsWith("WP-1 Launch the site", told.Preview, StringComparison.Ordinal);
        using var anaInbox = await ana.GetAsync(new Uri("/api/notifications", UriKind.Relative));
        Assert.DoesNotContain((await anaInbox.ReadAsync<InboxDto>()).Items, i => i.Kind == "task_assigned");

        // Saved again with the task moved on and Ben unassigned: the index follows, and no one is told twice.
        parent.Assignees = [];
        parent.Column = "In progress";
        child.Column = "Done";
        await SaveAsync(ana, kanbanId, State(parent, child));
        using var after = await ben.GetAsync(new Uri($"/api/orgs/{orgId}/tasks?assignee=me", UriKind.Relative));
        Assert.Empty(await after.ReadAsync<List<TaskSummaryDto>>());
        using var all = await ben.GetAsync(new Uri($"/api/kanbans/{kanbanId}/tasks", UriKind.Relative));
        Assert.Equal("In progress", (await all.ReadAsync<List<TaskSummaryDto>>()).Single(t => t.Key == "WP-1").Column);

        // Someone outside the organisation sees none of it.
        var other = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, other.Id, "Commenter");
        await outsider.GetAsync(new Uri($"/api/orgs/{orgId}/tasks", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        using var hidden = await outsider.GetAsync(new Uri($"/api/kanbans/{kanbanId}/tasks", UriKind.Relative));
        Assert.Contains(hidden.StatusCode, new[] { HttpStatusCode.NotFound, HttpStatusCode.Forbidden });
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        outsider.Dispose();
    }

    [Fact]
    public async Task Tasks_due_today_or_overdue_remind_their_assignees_once()
    {
        var (admin, _, ana, _, ben, benId, kanbanId) = await KanbanAsync();
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        await SaveAsync(ana, kanbanId, State(
            new KanbanDoc.Task { Id = "a", Key = "WP-1", Title = "Due today", Assignees = [benId.ToString()], Due = today.ToString("yyyy-MM-dd") },
            new KanbanDoc.Task { Id = "b", Key = "WP-2", Title = "Late", Assignees = [benId.ToString()], Due = today.AddDays(-3).ToString("yyyy-MM-dd") },
            new KanbanDoc.Task { Id = "c", Key = "WP-3", Title = "Late but done", Assignees = [benId.ToString()], Due = today.AddDays(-3).ToString("yyyy-MM-dd"), Column = "Done" },
            new KanbanDoc.Task { Id = "d", Key = "WP-4", Title = "Later", Assignees = [benId.ToString()], Due = today.AddDays(3).ToString("yyyy-MM-dd") }));

        var service = factory.Services.GetRequiredService<TaskDueService>();
        Assert.True(await service.RunAsync(default) >= 2);
        await service.RunAsync(default);

        using var inbox = await ben.GetAsync(new Uri("/api/notifications", UriKind.Relative));
        var items = (await inbox.ReadAsync<InboxDto>()).Items.Where(i => i.DocId == kanbanId && i.Kind != "task_assigned").ToList();
        Assert.Single(items, i => i.Kind == "task_due" && i.Preview.StartsWith("WP-1", StringComparison.Ordinal));
        Assert.Single(items, i => i.Kind == "task_overdue" && i.Preview.StartsWith("WP-2", StringComparison.Ordinal));
        Assert.DoesNotContain(items, i => i.Preview.StartsWith("WP-3", StringComparison.Ordinal) || i.Preview.StartsWith("WP-4", StringComparison.Ordinal));
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
    }

    [Fact]
    public async Task The_server_adds_and_changes_tasks_as_live_edits_with_keys_sub_tasks_and_links()
    {
        var (admin, orgId, ana, anaId, ben, benId, kanbanId) = await KanbanAsync();
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var editor = scope.ServiceProvider.GetRequiredService<KanbanEditor>();
            var first = await editor.CreateAsync(kanbanId, anaId, new TaskChange("Plan the launch", Assignees: ["me"], Tags: ["launch"], Due: "2026-12-24"), default);
            var second = await editor.CreateAsync(kanbanId, anaId, new TaskChange("Book the venue", Parent: first!.Key, Link: [$"blocks {first.Key}"]), default);
            Assert.Equal(("WP-1", "WP-2"), (first.Key, second!.Key));
            Assert.Equal(first.Id, second.Parent);

            var moved = await editor.UpdateAsync(kanbanId, anaId, "wp-2", new TaskChange(Column: "in progress", Assignees: [benId.ToString()], Priority: "highest"), default);
            Assert.Equal("highest", moved!.Priority);
            await Assert.ThrowsAsync<InvalidOperationException>(() => editor.UpdateAsync(kanbanId, anaId, "WP-1", new TaskChange(Parent: "WP-2"), default));
            await Assert.ThrowsAsync<InvalidOperationException>(() => editor.UpdateAsync(kanbanId, anaId, "WP-1", new TaskChange(Column: "Nowhere"), default));

            var state = await editor.ReadAsync(kanbanId, default);
            var relation = Assert.Single(state!.Relations);
            Assert.Equal((second.Id, first.Id, "blocks"), (relation.From, relation.To, relation.Type));
            Assert.Equal("In progress", state.ColumnOf(state.Tasks[second.Id])!.Name);

            // Saved straight away: in the index, the summary (with its #tags) and Ben's inbox.
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            Assert.Equal(2, await db.KanbanTasks.CountAsync(t => t.DocId == kanbanId));
            Assert.Contains("#launch", (await db.Docs.SingleAsync(d => d.Id == kanbanId)).Content, StringComparison.Ordinal);
        }

        using var tagged = await ana.GetAsync(new Uri($"/api/orgs/{orgId}/docs/tags", UriKind.Relative));
        Assert.Contains("launch", await tagged.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        using var inbox = await ben.GetAsync(new Uri("/api/notifications", UriKind.Relative));
        Assert.Contains((await inbox.ReadAsync<InboxDto>()).Items, i => i.Kind == "task_assigned" && i.Preview.StartsWith("WP-2", StringComparison.Ordinal));
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
    }

    [Fact]
    public async Task Docs_link_tasks_and_show_up_as_the_kanbans_backlinks_and_the_tasks_mentions()
    {
        var (admin, orgId, ana, _, ben, _, kanbanId) = await KanbanAsync();
        using var created = await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Release notes" });
        var notes = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        await using (var live = await DocsProbe.ConnectAsync(factory, ana))
        {
            await live.OpenAsync(notes.Id);
            var seq = await live.UpdateAsync(notes.Id, 1);
            Assert.True(await live.SnapshotAsync(notes.Id, [0xAA], "Ships with [[task:wp-1]] and [[task:WP-2|the copy]]; not [[task:nope]] or `[[task:WP-3]]`.", seq));
        }

        using var kanban = await ben.GetAsync(new Uri($"/api/docs/{kanbanId}", UriKind.Relative));
        Assert.Equal(notes.Id, Assert.Single((await kanban.ReadAsync<BacklinksDto>()).Backlinks).Id);
        using var mentions = await ben.GetAsync(new Uri($"/api/kanbans/{kanbanId}/mentions?key=WP-1", UriKind.Relative));
        Assert.Equal("Release notes", Assert.Single(await mentions.ReadAsync<List<TaskMentionDto>>()).Title);
        using var none = await ben.GetAsync(new Uri($"/api/kanbans/{kanbanId}/mentions?key=WP-3", UriKind.Relative));
        Assert.Empty(await none.ReadAsync<List<TaskMentionDto>>());

        // Parsed the same way everywhere: two task links, nothing else.
        var (links, _) = DocMarkdown.Extract("[[task:wp-1]] [[task:WP-2|x]] [[task:nope]] [[Plan]]");
        Assert.Equal(["WP-1", "WP-2"], links.Select(l => l.TaskKey).OfType<string>());
        Assert.Equal("WP", links[0].TaskPrefix);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
    }
}
