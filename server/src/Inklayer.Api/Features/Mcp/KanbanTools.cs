using System.ComponentModel;
using Inklayer.Api.Access;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Features.Kanban;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace Inklayer.Api.Features.Mcp;

/// <summary>Kanban boards for MCP clients: read them, and add and change their tasks, as the signed-in person.</summary>
[McpServerToolType]
internal static class KanbanTools
{
    /// <summary>Hidden and refused while kanbans (or docs) are turned off.</summary>
    public static readonly HashSet<string> Names = new(StringComparer.Ordinal)
    {
        "create_kanban", "read_kanban", "list_tasks", "create_task", "update_task", "delete_task",
    };

    [McpServerTool(Name = "create_kanban", OpenWorld = false), Description(
        "Create a kanban board in an organisation: columns (To do, In progress, Done to start with) of tasks with keys like WEB-12, " +
        "assignees, due dates, tags, sub-tasks and links between tasks. Then add tasks with create_task.")]
    public static async Task<string> CreateKanban(
        [Description("Organisation id")] Guid orgId, [Description("Title")] string title,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, FeatureSwitches features,
        CancellationToken ct, [Description("Folder path; empty for the top level")] string? folder = null,
        [Description("The prefix of its task keys, 2 to 10 capital letters (WEB for WEB-12); made from the title if left out")] string? keyPrefix = null)
    {
        var created = ToolResults.Value<DocSummaryResponse>(
            await DocEndpoints.CreateAsync(orgId, new CreateDocRequest(folder, title, DocKinds.Kanban, keyPrefix), access, currentUser, db, indexer, clock, features, ct));
        var prefix = await db.KanbanBoards.Where(k => k.DocId == created.Id).Select(k => k.KeyPrefix).SingleAsync(ct);
        return ToolResults.ToJson(new { created.Id, created.Folder, created.Title, created.Kind, KeyPrefix = prefix });
    }

    [McpServerTool(Name = "read_kanban", ReadOnly = true), Description(
        "A kanban as it is now (including changes people are making right now): its columns in order, and every task with its key, " +
        "title, description, column, type, priority, assignees (user ids and names), due date, tags, parent (for sub-tasks), linked doc, " +
        "and links to other tasks (blocks, relates, duplicates, clones).")]
    public static async Task<string> ReadKanban([Description("Kanban id")] Guid kanbanId, AccessService access, InklayerDbContext db, KanbanEditor kanbans, CancellationToken ct)
    {
        await RequireAsync(kanbanId, Permission.View, access, db, ct);
        var state = await kanbans.ReadAsync(kanbanId, ct) ?? throw new McpException("That isn't a kanban.");
        var userIds = state.Tasks.Values.SelectMany(t => t.AssigneeIds).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        return ToolResults.ToJson(new
        {
            Columns = state.Columns.Select(c => new { c.Id, c.Name, c.Category }),
            Tasks = state.Ordered().Select(t => Describe(t, state, names)),
        });
    }

    [McpServerTool(Name = "list_tasks", ReadOnly = true), Description(
        "Tasks across an organisation's kanbans (as of their last save, a few seconds ago): by default the open tasks assigned to the " +
        "signed-in person, soonest due first.")]
    public static async Task<string> ListTasks(
        [Description("Organisation id")] Guid orgId, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct,
        [Description("\"me\" (the default), a user id, or \"anyone\"")] string? assignee = "me",
        [Description("open (the default), done or all")] string? status = null, [Description("Only tasks with this tag")] string? tag = null,
        [Description("overdue, or week (due within 7 days)")] string? due = null, [Description("Words in the title or key")] string? query = null)
    {
        var result = await KanbanEndpoints.TasksAsync(orgId, assignee == "anyone" ? null : assignee, status, tag, due, query, 100, access, currentUser, db, clock, ct);
        return ToolResults.ToJson(ToolResults.Value<object>(result));
    }

    [McpServerTool(Name = "create_task", OpenWorld = false), Description(
        "Add a task to a kanban, at the bottom of its column (the first column if none is given). It gets the next key, like WEB-12. " +
        "People with the kanban open see it at once.")]
    public static async Task<string> CreateTask(
        [Description("Kanban id")] Guid kanbanId, [Description("The task")] TaskChange task,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, KanbanEditor kanbans, CancellationToken ct)
    {
        await RequireAsync(kanbanId, Permission.Comment, access, db, ct);
        try
        {
            var created = await kanbans.CreateAsync(kanbanId, currentUser.Id!.Value, task, ct) ?? throw new McpException("That isn't a kanban.");
            return ToolResults.ToJson(new { created.Id, created.Key, created.Title });
        }
        catch (InvalidOperationException e)
        {
            throw new McpException(e.Message);
        }
    }

    [McpServerTool(Name = "update_task", OpenWorld = false), Description(
        "Change a task on a kanban: only the fields given change. Move it with column; assign it with assignees; make it a sub-task " +
        "with parent; link it to other tasks with link (\"blocks WEB-3\").")]
    public static async Task<string> UpdateTask(
        [Description("Kanban id")] Guid kanbanId, [Description("The task's key (WEB-12) or id")] string task, [Description("What to change")] TaskChange change,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, KanbanEditor kanbans, CancellationToken ct)
    {
        await RequireAsync(kanbanId, Permission.Comment, access, db, ct);
        try
        {
            var updated = await kanbans.UpdateAsync(kanbanId, currentUser.Id!.Value, task, change, ct) ?? throw new McpException($"There's no task {task} on this kanban.");
            return ToolResults.ToJson(new { updated.Id, updated.Key, updated.Title });
        }
        catch (InvalidOperationException e)
        {
            throw new McpException(e.Message);
        }
    }

    [McpServerTool(Name = "delete_task", Destructive = true, OpenWorld = false), Description("Delete a task from a kanban. Its sub-tasks stay, on their own. It can be brought back from the kanban's history.")]
    public static async Task<string> DeleteTask(
        [Description("Kanban id")] Guid kanbanId, [Description("The task's key (WEB-12) or id")] string task,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, KanbanEditor kanbans, CancellationToken ct)
    {
        await RequireAsync(kanbanId, Permission.Comment, access, db, ct);
        return await kanbans.DeleteAsync(kanbanId, currentUser.Id!.Value, task, ct) ? "Deleted." : throw new McpException($"There's no task {task} on this kanban.");
    }

    private static object Describe(KanbanDoc.Task t, KanbanDoc.State state, Dictionary<Guid, string> names) => new
    {
        t.Id, t.Key, t.Title, t.Description, Column = state.ColumnOf(t)?.Name, t.Type, t.Priority,
        Assignees = t.AssigneeIds.Select(id => new { Id = id, Name = names.GetValueOrDefault(id, "someone") }),
        t.Due, t.Tags, t.Estimate, Parent = t.Parent is { } p ? state.Tasks.GetValueOrDefault(p)?.Key : null, t.DocId,
        Links = state.Relations.Where(r => r.From == t.Id).Select(r => $"{r.Type} {state.Tasks[r.To].Key}")
            .Concat(state.Relations.Where(r => r.To == t.Id).Select(r => $"{Reverse(r.Type)} {state.Tasks[r.From].Key}")),
        Tracker = t.ExtKey is null ? null : new { Key = t.ExtKey, Url = t.ExtUrl },
    };

    private static string Reverse(string type) => type switch
    {
        "blocks" => "is blocked by",
        "duplicates" => "is duplicated by",
        "clones" => "is cloned by",
        _ => type,
    };

    private static async Task RequireAsync(Guid kanbanId, Permission permission, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanEndpoints.KanbanAsync(kanbanId, permission, access, db, ct) is { } denied)
        {
            ToolResults.Ok(denied);
        }
    }
}
