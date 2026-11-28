using Inklayer.Api.Features.Docs;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Kanban;

/// <summary>
/// Keeps <see cref="KanbanTask"/> in step with a kanban's Yjs document: called with each snapshot, it reads the tasks from the
/// state itself (so nothing depends on what a browser says), and updates their rows in place, keeping what only the server
/// knows (reminders sent, the tracker's last-synced fields).
/// </summary>
internal static class KanbanIndexer
{
    /// <summary>People newly assigned to a task.</summary>
    public sealed record Assignment(KanbanTask Task, IReadOnlyList<Guid> Added);

    /// <summary>Updates the kanban's task rows from <paramref name="state"/> (its whole Yjs state). Call inside the snapshot's transaction.</summary>
    public static async Task<List<Assignment>> IndexAsync(InklayerDbContext db, Doc doc, byte[] state, DateTime now, CancellationToken ct)
    {
        KanbanDoc.State board;
        using (var ydoc = DocText.Load(state, []))
        {
            board = KanbanDoc.Read(ydoc);
        }

        return await IndexAsync(db, doc, board, now, ct);
    }

    public static async Task<List<Assignment>> IndexAsync(InklayerDbContext db, Doc doc, KanbanDoc.State board, DateTime now, CancellationToken ct)
    {
        var rows = await db.KanbanTasks.Include(t => t.Assignees).Include(t => t.Tags).Where(t => t.DocId == doc.Id).ToDictionaryAsync(t => t.TaskId, StringComparer.Ordinal, ct);
        var assigned = new List<Assignment>();
        foreach (var task in board.Tasks.Values)
        {
            if (task.Id.Length > 64)
            {
                continue;
            }

            var column = board.ColumnOf(task);
            if (!rows.Remove(task.Id, out var row))
            {
                row = new KanbanTask { DocId = doc.Id, TaskId = task.Id, OrganizationId = doc.OrganizationId, UpdatedAt = now };
                db.KanbanTasks.Add(row);
            }

            var changed = Set(row.Key, Clip(task.Key, 32), v => row.Key = v!)
                | Set(row.Title, Clip(task.Title, KanbanTask.MaxTitleLength), v => row.Title = v!)
                | Set(row.ColumnId, Clip(column?.Id ?? "", 64), v => row.ColumnId = v!)
                | Set(row.ColumnName, Clip(column?.Name ?? "", 200), v => row.ColumnName = v!)
                | Set(row.Category, column?.Category ?? KanbanCategories.Todo, v => row.Category = v!)
                | Set(row.Type, task.Type, v => row.Type = v!)
                | Set(row.Priority, task.Priority, v => row.Priority = v!)
                | Set(row.ParentTaskId, task.Parent is { Length: <= 64 } p ? p : null, v => row.ParentTaskId = v)
                | Set(row.ExternalId, ClipOrNull(task.ExtId, 200), v => row.ExternalId = v)
                | Set(row.ExternalKey, ClipOrNull(task.ExtKey, 200), v => row.ExternalKey = v)
                | Set(row.ExternalUrl, ClipOrNull(task.ExtUrl, 2000), v => row.ExternalUrl = v);
            var due = task.DueDate;
            if (row.Due != due)
            {
                row.Due = due;
                changed = true;
            }

            var linked = Guid.TryParse(task.DocId, out var docId) ? docId : (Guid?)null;
            if (row.LinkedDocId != linked)
            {
                row.LinkedDocId = linked;
                changed = true;
            }

            var people = task.AssigneeIds.Distinct().ToList();
            var added = people.Where(p => row.Assignees.All(a => a.UserId != p)).ToList();
            foreach (var gone in row.Assignees.Where(a => !people.Contains(a.UserId)).ToList())
            {
                row.Assignees.Remove(gone);
                changed = true;
            }

            foreach (var person in added)
            {
                row.Assignees.Add(new KanbanTaskAssignee { DocId = doc.Id, TaskId = task.Id, UserId = person });
                changed = true;
            }

            var tags = task.Tags.Select(t => DocAppearance.NormalizeTag(t, out _)).OfType<string>().Distinct(StringComparer.Ordinal).ToList();
            foreach (var gone in row.Tags.Where(t => !tags.Contains(t.Tag)).ToList())
            {
                row.Tags.Remove(gone);
                changed = true;
            }

            foreach (var tag in tags.Where(t => row.Tags.All(x => x.Tag != t)))
            {
                row.Tags.Add(new KanbanTaskTag { DocId = doc.Id, TaskId = task.Id, Tag = tag });
                changed = true;
            }

            if (changed)
            {
                row.UpdatedAt = now;
            }

            if (added.Count > 0)
            {
                assigned.Add(new Assignment(row, added));
            }
        }

        // Tasks that are gone.
        db.KanbanTasks.RemoveRange(rows.Values);
        return assigned;
    }

    private static bool Set(string? current, string? value, Action<string?> apply)
    {
        if (string.Equals(current, value, StringComparison.Ordinal))
        {
            return false;
        }

        apply(value);
        return true;
    }

    private static string Clip(string value, int max) => value.Length <= max ? value : value[..max];

    private static string? ClipOrNull(string? value, int max) => value is null ? null : Clip(value, max);
}
