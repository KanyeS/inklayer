using System.ComponentModel;
using System.Globalization;
using Inklayer.Api.Features.Docs;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Kanban;

/// <summary>A change to a task, for the AI tools: only the fields given change. Empty strings clear optional fields.</summary>
public sealed record TaskChange(
    [property: Description("The task's title")] string? Title = null,
    [property: Description("Markdown; may link docs with [[Title]] and people with <@user-id>")] string? Description = null,
    [property: Description("The column's name or id (a new task goes in the first column if left out)")] string? Column = null,
    [property: Description("task, bug, story or epic")] string? Type = null,
    [property: Description("highest, high, medium, low or lowest")] string? Priority = null,
    [property: Description("Who it's assigned to: user ids, or \"me\". Replaces the list; [] unassigns everyone")] IReadOnlyList<string>? Assignees = null,
    [property: Description("Due date, yyyy-mm-dd; empty to clear")] string? Due = null,
    [property: Description("Tags, without #. Replaces the list")] IReadOnlyList<string>? Tags = null,
    [property: Description("The parent task's key (makes this a sub-task); empty to make it stand alone")] string? Parent = null,
    [property: Description("Estimate in points; 0 to clear")] double? Estimate = null,
    [property: Description("Links to add: \"blocks WEB-3\", \"relates WEB-4\", \"duplicates WEB-5\", \"clones WEB-6\"")] IReadOnlyList<string>? Link = null,
    [property: Description("Links to remove, written the same way")] IReadOnlyList<string>? Unlink = null);

/// <summary>
/// Changes a kanban's tasks on the server, as one Yjs change sent to everyone with it open (through <see cref="DocText.ChangeAsync"/>),
/// with the summary written afresh. Used by the AI tools and the tracker sync.
/// </summary>
internal sealed class KanbanEditor(InklayerDbContext db, DocText docText, TimeProvider clock)
{
    /// <summary>Applies <paramref name="change"/> to the kanban's document (return false to change nothing). Null if it doesn't exist.</summary>
    public async Task<KanbanDoc.State?> ApplyAsync(Guid kanbanId, Guid userId, Func<YDotNet.Document.Doc, KanbanDoc.State, Task<bool>> change, CancellationToken ct)
    {
        KanbanDoc.State? final = null;
        var result = await docText.ChangeAsync(kanbanId, userId, DocKinds.Kanban, async (ydoc, storedSummary) =>
        {
            var state = KanbanDoc.Read(ydoc);
            if (!await change(ydoc, state))
            {
                final = state;
                return (storedSummary, null);
            }

            final = KanbanDoc.Read(ydoc);
            return (storedSummary, await SummaryAsync(final, ct));
        }, ct);
        return result is null ? null : final;
    }

    /// <summary>The kanban as it is now (live edits included). Null if it doesn't exist or isn't a kanban.</summary>
    public async Task<KanbanDoc.State?> ReadAsync(Guid kanbanId, CancellationToken ct)
    {
        var doc = await db.Docs.AsNoTracking().Where(d => d.Id == kanbanId && d.DeletedAt == null && d.Kind == DocKinds.Kanban)
            .Select(d => new { d.State, d.SnapshotSeq }).SingleOrDefaultAsync(ct);
        if (doc is null)
        {
            return null;
        }

        var updates = await db.DocUpdates.AsNoTracking().Where(u => u.DocId == kanbanId && u.Seq > doc.SnapshotSeq).OrderBy(u => u.Seq)
            .Select(u => u.Bytes).ToListAsync(ct);
        using var ydoc = DocText.Load(doc.State, updates);
        return KanbanDoc.Read(ydoc);
    }

    /// <summary>The summary, with the docs tasks link written by their current titles.</summary>
    public async Task<string> SummaryAsync(KanbanDoc.State state, CancellationToken ct)
    {
        var ids = state.Tasks.Values.Select(t => Guid.TryParse(t.DocId, out var id) ? id : Guid.Empty).Where(id => id != Guid.Empty).Distinct().ToList();
        var titles = ids.Count == 0 ? [] : await db.Docs.AsNoTracking().Where(d => ids.Contains(d.Id) && d.DeletedAt == null)
            .Select(d => new { d.Id, d.Folder, d.Title }).ToDictionaryAsync(d => d.Id, d => d.Folder.Length > 0 ? $"{d.Folder}/{d.Title}" : d.Title, ct);
        return KanbanDoc.Summary(state, titles);
    }

    /// <summary>Adds a task (at the bottom of its column). Throws <see cref="InvalidOperationException"/> to refuse.</summary>
    public async Task<KanbanDoc.Task?> CreateAsync(Guid kanbanId, Guid userId, TaskChange change, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(change.Title))
        {
            throw new InvalidOperationException("A new task needs a title.");
        }

        var current = await ReadAsync(kanbanId, ct) ?? throw new InvalidOperationException("That isn't a kanban.");
        if (current.Tasks.Count >= KanbanEndpoints.MaxTasks)
        {
            throw new InvalidOperationException($"A kanban can have at most {KanbanEndpoints.MaxTasks} tasks.");
        }

        var keys = await KanbanEndpoints.ReserveAsync(db, kanbanId, 1, ct);
        var prefix = await db.KanbanBoards.AsNoTracking().Where(k => k.DocId == kanbanId).Select(k => k.KeyPrefix).SingleAsync(ct);
        var now = Now();
        var task = new KanbanDoc.Task
        {
            Id = Guid.NewGuid().ToString(), Key = $"{prefix}-{keys.First}", CreatedAt = now, CreatedBy = userId.ToString(), UpdatedAt = now,
            Reporter = userId.ToString(),
        };
        var state = await ApplyAsync(kanbanId, userId, (ydoc, state) =>
        {
            var columns = KanbanDoc.EnsureColumns(ydoc, state);
            task.Column = columns[0].Id;
            var relations = Fill(task, change, state, userId, isNew: true, out _);
            task.Rank = Ranks.Between(state.Tasks.Values.Where(t => t.Column == task.Column).Select(t => t.Rank).DefaultIfEmpty("").Max(StringComparer.Ordinal), null);
            KanbanDoc.Insert(ydoc, task);
            ApplyRelations(ydoc, state, task, relations);
            return Task.FromResult(true);
        }, ct);
        return state?.Tasks.GetValueOrDefault(task.Id);
    }

    /// <summary>Changes the task with this key (or id). Null if there's no such task.</summary>
    public async Task<KanbanDoc.Task?> UpdateAsync(Guid kanbanId, Guid userId, string keyOrId, TaskChange change, CancellationToken ct)
    {
        string? id = null;
        var state = await ApplyAsync(kanbanId, userId, (ydoc, state) =>
        {
            var task = Find(state, keyOrId);
            if (task is null)
            {
                return Task.FromResult(false);
            }

            id = task.Id;
            var relations = Fill(task, change, state, userId, isNew: false, out var fields);
            if (fields.Count == 0 && relations.Add.Count == 0 && relations.Remove.Count == 0)
            {
                return Task.FromResult(false);
            }

            task.UpdatedAt = Now();
            fields.Add("updatedAt");
            if (fields.Contains("column"))
            {
                task.Rank = Ranks.Between(state.Tasks.Values.Where(t => t.Column == task.Column && t.Id != task.Id).Select(t => t.Rank).DefaultIfEmpty("").Max(StringComparer.Ordinal), null);
                fields.Add("rank");
            }

            KanbanDoc.Update(ydoc, task, fields);
            ApplyRelations(ydoc, state, task, relations);
            return Task.FromResult(true);
        }, ct);
        return id is null ? null : state?.Tasks.GetValueOrDefault(id);
    }

    public async Task<bool> DeleteAsync(Guid kanbanId, Guid userId, string keyOrId, CancellationToken ct)
    {
        var found = false;
        await ApplyAsync(kanbanId, userId, (ydoc, state) =>
        {
            if (Find(state, keyOrId) is not { } task)
            {
                return Task.FromResult(false);
            }

            found = true;
            KanbanDoc.Remove(ydoc, state, task.Id);
            return Task.FromResult(true);
        }, ct);
        return found;
    }

    public static KanbanDoc.Task? Find(KanbanDoc.State state, string keyOrId)
    {
        var wanted = keyOrId.Trim();
        return state.Tasks.GetValueOrDefault(wanted) ?? state.Tasks.Values.FirstOrDefault(t => string.Equals(t.Key, wanted, StringComparison.OrdinalIgnoreCase));
    }

    private sealed record RelationChanges(List<(string Type, string To)> Add, List<(string Type, string To)> Remove);

    /// <summary>Copies <paramref name="change"/> into <paramref name="task"/>, checking it; <paramref name="fields"/> are those that changed.</summary>
    private static RelationChanges Fill(KanbanDoc.Task task, TaskChange change, KanbanDoc.State state, Guid userId, bool isNew, out HashSet<string> fields)
    {
        var changed = new HashSet<string>(StringComparer.Ordinal);
        void Set(string field, bool differs, Action apply)
        {
            if (differs || isNew)
            {
                apply();
                changed.Add(field);
            }
        }

        if (change.Title is { } title)
        {
            var clean = title.ReplaceLineEndings(" ").Trim();
            if (clean.Length == 0)
            {
                throw new InvalidOperationException("A task's title can't be empty.");
            }

            clean = clean.Length > KanbanTask.MaxTitleLength ? clean[..KanbanTask.MaxTitleLength] : clean;
            Set("title", clean != task.Title, () => task.Title = clean);
        }

        if (change.Description is { } description)
        {
            Set("description", description != task.Description, () => task.Description = description.Length > 50_000 ? description[..50_000] : description);
        }

        if (change.Column is { Length: > 0 } columnName)
        {
            var column = state.Columns.FirstOrDefault(c => c.Id == columnName)
                ?? state.Columns.FirstOrDefault(c => string.Equals(c.Name, columnName.Trim(), StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException($"There's no column \"{columnName}\". The columns are: {string.Join(", ", state.Columns.Select(c => c.Name))}.");
            Set("column", column.Id != task.Column, () => task.Column = column.Id);
        }

        if (change.Type is { } type)
        {
            var t = type.Trim().ToLowerInvariant();
            if (!KanbanDoc.Types.Contains(t))
            {
                throw new InvalidOperationException("A task's type is task, bug, story or epic.");
            }

            Set("type", t != task.Type, () => task.Type = t);
        }

        if (change.Priority is { } priority)
        {
            var p = priority.Trim().ToLowerInvariant();
            if (!KanbanDoc.Priorities.Contains(p))
            {
                throw new InvalidOperationException("A task's priority is highest, high, medium, low or lowest.");
            }

            Set("priority", p != task.Priority, () => task.Priority = p);
        }

        if (change.Assignees is { } assignees)
        {
            var ids = assignees.Select(a => a.Trim().Equals("me", StringComparison.OrdinalIgnoreCase) ? userId.ToString()
                    : Guid.TryParse(a, out var id) ? id.ToString() : throw new InvalidOperationException($"\"{a}\" isn't a user id. Use the ids people's names come with, or \"me\"."))
                .Distinct(StringComparer.Ordinal).Take(20).ToList();
            Set("assignees", !ids.SequenceEqual(task.Assignees), () => task.Assignees = ids);
        }

        if (change.Due is { } due)
        {
            string? value = null;
            if (due.Trim().Length > 0)
            {
                value = DateOnly.TryParseExact(due.Trim(), "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
                    ? date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                    : throw new InvalidOperationException("Write the due date as yyyy-mm-dd.");
            }

            Set("due", value != task.Due, () => task.Due = value);
        }

        if (change.Tags is { } tags)
        {
            var clean = tags.Select(t => DocAppearance.NormalizeTag(t, out _) ?? throw new InvalidOperationException($"\"{t}\" isn't a tag."))
                .Distinct(StringComparer.Ordinal).Take(30).ToList();
            Set("tags", !clean.SequenceEqual(task.Tags), () => task.Tags = clean);
        }

        if (change.Parent is { } parent)
        {
            string? parentId = null;
            if (parent.Trim().Length > 0)
            {
                var found = Find(state, parent) ?? throw new InvalidOperationException($"There's no task {parent} on this kanban.");
                // Not under itself, or under one of its own sub-tasks.
                for (var at = found; at is not null; at = at.Parent is { } p ? state.Tasks.GetValueOrDefault(p) : null)
                {
                    if (at.Id == task.Id)
                    {
                        throw new InvalidOperationException("A task can't be a sub-task of itself or of its own sub-tasks.");
                    }
                }

                parentId = found.Id;
            }

            Set("parent", parentId != task.Parent, () => task.Parent = parentId);
        }

        if (change.Estimate is { } estimate)
        {
            double? value = estimate <= 0 ? null : Math.Min(estimate, 10_000);
            Set("estimate", value != task.Estimate, () => task.Estimate = value);
        }

        fields = isNew ? [] : changed;
        return new RelationChanges(ParseLinks(change.Link, state, task), ParseLinks(change.Unlink, state, task));
    }

    private static List<(string Type, string To)> ParseLinks(IReadOnlyList<string>? links, KanbanDoc.State state, KanbanDoc.Task task)
    {
        var list = new List<(string, string)>();
        foreach (var link in links ?? [])
        {
            var parts = link.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length != 2 || !KanbanDoc.RelationTypes.Contains(parts[0].ToLowerInvariant()))
            {
                throw new InvalidOperationException($"Write links as \"blocks WEB-3\", \"relates WEB-4\", \"duplicates WEB-5\" or \"clones WEB-6\", not \"{link}\".");
            }

            var other = Find(state, parts[1]) ?? throw new InvalidOperationException($"There's no task {parts[1]} on this kanban.");
            if (other.Id == task.Id)
            {
                throw new InvalidOperationException("A task can't link to itself.");
            }

            list.Add((parts[0].ToLowerInvariant(), other.Id));
        }

        return list;
    }

    private static void ApplyRelations(YDotNet.Document.Doc ydoc, KanbanDoc.State state, KanbanDoc.Task task, RelationChanges changes)
    {
        foreach (var (type, to) in changes.Remove)
        {
            foreach (var r in state.Relations.Where(r => r.Type == type && ((r.From == task.Id && r.To == to) || (type == "relates" && r.From == to && r.To == task.Id))))
            {
                KanbanDoc.RemoveRelation(ydoc, r.Id);
            }
        }

        foreach (var (type, to) in changes.Add)
        {
            if (!state.Relations.Any(r => r.Type == type && r.From == task.Id && r.To == to))
            {
                KanbanDoc.AddRelation(ydoc, new KanbanDoc.Relation(Guid.NewGuid().ToString(), task.Id, to, type));
            }
        }
    }

    private string Now() => clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
}
