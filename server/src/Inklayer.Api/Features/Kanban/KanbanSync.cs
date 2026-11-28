using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Inklayer.Api.Features.Issues;
using Inklayer.Domain.Docs;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Kanban;

/// <summary>What a sync did.</summary>
public sealed record KanbanSyncResult(int Pulled, int Pushed, int Created, string? Error);

/// <summary>
/// Keeps a kanban in step with a tracker's project (Jira). Each field of each task is compared three ways: as the tracker has
/// it now, as the kanban has it now, and as both had it after the last sync (<see cref="KanbanTask.SyncedFields"/>). A field
/// that changed on one side only is copied to the other; one that changed on both goes to whichever side was edited last.
/// The kanban's side is changed as one live Yjs edit, so people with it open see it arrive.
/// <list type="bullet">
/// <item>Tasks new on the kanban become issues (unless it syncs only from the tracker, or they were there before it was
/// connected and <see cref="KanbanBoard.PushExisting"/> is off); issues new in the tracker become tasks.</item>
/// <item>Deleting is never synced: a task deleted here leaves its issue alone, and the other way round.</item>
/// <item>People match by email: the tracker's account for each person who can be assigned. An assignee in the tracker with
/// no match leaves the task unassigned here; one here with no account there leaves the issue's assignee as it is.</item>
/// </list>
/// </summary>
internal sealed partial class KanbanSync(
    InklayerDbContext db, KanbanEditor editor, Trackers trackers, TrackerAccounts accounts, TimeProvider clock, ILogger<KanbanSync> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>One sync per kanban at a time: the timer's and someone's "Sync now" don't both push the same change.</summary>
    private static readonly ConcurrentDictionary<Guid, SemaphoreSlim> Running = new();

    /// <summary>People's tracker accounts by email, per connection, looked up at most once an hour.</summary>
    private static readonly ConcurrentDictionary<(Guid Connection, string Email), (string? AccountId, DateTime At)> Accounts = new();

    private static readonly TimeSpan AccountsFor = TimeSpan.FromHours(1);

    /// <summary>The fields synced, as both sides last agreed (stored per task as JSON).</summary>
    internal sealed record Fields(
        string Title, string Description, string Status, string? Assignee, string? Due, IReadOnlyList<string> Labels, string Priority, string Type,
        string? Parent, IReadOnlyList<string> Links)
    {
        public static Fields? Parse(string? json)
        {
            if (string.IsNullOrEmpty(json))
            {
                return null;
            }

            try
            {
                return JsonSerializer.Deserialize<Fields>(json, Json);
            }
            catch (JsonException)
            {
                return null;
            }
        }

        public string ToJson() => JsonSerializer.Serialize(this, Json);
    }

    /// <summary>The tracker's status id → the kanban's column id, from <see cref="KanbanBoard.StatusMap"/>.</summary>
    public static Dictionary<string, string> ParseStatusMap(string? json)
    {
        if (string.IsNullOrEmpty(json))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, string>>(json, Json) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static string WriteStatusMap(IReadOnlyDictionary<string, string> map) => JsonSerializer.Serialize(map, Json);

    /// <summary>A map from the tracker's statuses to columns: by name, else the first column of the same kind, else the first.</summary>
    public static Dictionary<string, string> DefaultStatusMap(IReadOnlyList<BoardStatus> statuses, IReadOnlyList<KanbanDoc.Column> columns)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var status in statuses)
        {
            var column = columns.FirstOrDefault(c => string.Equals(c.Name.Trim(), status.Name.Trim(), StringComparison.OrdinalIgnoreCase))
                ?? columns.FirstOrDefault(c => c.Category == status.Category) ?? (columns.Count > 0 ? columns[0] : null);
            if (column is not null)
            {
                map[status.Id] = column.Id;
            }
        }

        return map;
    }

    /// <summary>Syncs the kanban with its tracker now. Null if it isn't connected to one (or is already syncing).</summary>
    public async Task<KanbanSyncResult?> SyncAsync(Guid kanbanId, CancellationToken ct)
    {
        var gate = Running.GetOrAdd(kanbanId, _ => new SemaphoreSlim(1, 1));
        if (!await gate.WaitAsync(0, ct))
        {
            return null;
        }

        try
        {
            return await SyncCoreAsync(kanbanId, ct);
        }
        finally
        {
            gate.Release();
        }
    }

    private sealed class Plan
    {
        /// <summary>Kanban tasks to change: task id → the fields to write (from the tracker).</summary>
        public Dictionary<string, (KanbanDoc.Task Task, HashSet<string> Fields)> Local { get; } = new(StringComparer.Ordinal);

        public List<(KanbanDoc.Task Task, BoardIssue Issue)> NewTasks { get; } = [];

        public List<KanbanDoc.Relation> NewRelations { get; } = [];

        /// <summary>What each task's synced fields become, by task id.</summary>
        public Dictionary<string, Fields> Synced { get; } = new(StringComparer.Ordinal);

        /// <summary>The column each task the tracker moved (or brought in) goes in, by task id.</summary>
        public Dictionary<string, string> Columns { get; } = new(StringComparer.Ordinal);

        /// <summary>People by their tracker account.</summary>
        public Dictionary<string, Guid> PeopleByAccount { get; set; } = new(StringComparer.Ordinal);

        public int Pushed { get; set; }

        public int Created { get; set; }

        public string? Error { get; set; }
    }

    private async Task<KanbanSyncResult?> SyncCoreAsync(Guid kanbanId, CancellationToken ct)
    {
        var board = await db.KanbanBoards.SingleOrDefaultAsync(k => k.DocId == kanbanId, ct);
        var doc = await db.Docs.AsNoTracking().Where(d => d.Id == kanbanId && d.DeletedAt == null).Select(d => new { d.CreatedByUserId }).SingleOrDefaultAsync(ct);
        if (board?.TrackerConnectionId is not { } connectionId || doc is null)
        {
            return null;
        }

        var connection = await db.IssueTrackerConnections.AsNoTracking().SingleOrDefaultAsync(c => c.Id == connectionId, ct);
        var syncUser = board.ConnectedByUserId ?? doc.CreatedByUserId;
        var started = clock.GetUtcNow().UtcDateTime;
        if (connection is null || trackers.For(connection.Kind) is not IBoardSync tracker)
        {
            return await FailAsync(board, "The tracker this kanban was connected to is gone, or can't sync boards.", ct);
        }

        if (await accounts.ForBackgroundAsync(connection, [syncUser], ct) is not { } token)
        {
            return await FailAsync(board, $"No {TrackerKinds.Name(connection.Kind)} account to sync with: whoever connected the kanban needs theirs connected, or the project a shared one.", ct);
        }

        var settings = IssueService.SettingsOf(connection);
        var plan = new Plan();
        try
        {
            var state = await editor.ReadAsync(kanbanId, ct) ?? throw new InvalidOperationException("That isn't a kanban.");
            var rows = await db.KanbanTasks.Where(t => t.DocId == kanbanId).ToDictionaryAsync(t => t.TaskId, StringComparer.Ordinal, ct);
            var statuses = await accounts.WithAsync(token, t => tracker.StatusesAsync(settings, t, ct), ct);
            var map = ParseStatusMap(board.StatusMap);
            foreach (var (status, column) in DefaultStatusMap(statuses, state.Columns).Where(d => !map.ContainsKey(d.Key)))
            {
                map[status] = column;
            }

            var minutes = board.SyncedAt is { } last ? (int)Math.Ceiling((started - last).TotalMinutes) + 2 : (int?)null;
            var issues = await accounts.WithAsync(token, t => tracker.ChangedAsync(settings, t, minutes, ct), ct);
            var people = await PeopleAsync(connection.Id, kanbanId, tracker, settings, token, ct);
            var context = new SyncContext(state, rows, statuses, map, people);
            plan.PeopleByAccount = people.PersonOf;

            Pull(plan, context, issues, board.SyncDirection);
            if (board.SyncDirection == KanbanSyncDirections.Both)
            {
                await PushAsync(plan, context, tracker, settings, token, board, issues, ct);
            }

            await ApplyAsync(kanbanId, syncUser, plan, ct);

            board.SyncedAt = plan.Error is null ? started : board.SyncedAt ?? started;
            board.SyncError = plan.Error;
            board.StatusMap = WriteStatusMap(map);
            await db.SaveChangesAsync(ct);
            return new KanbanSyncResult(plan.Local.Count + plan.NewTasks.Count, plan.Pushed, plan.Created, plan.Error);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            LogFailed(logger, ex, kanbanId);
            return await FailAsync(board, ex.Message, ct);
        }
    }

    private async Task<KanbanSyncResult> FailAsync(KanbanBoard board, string message, CancellationToken ct)
    {
        board.SyncError = message.Length > 1000 ? message[..1000] : message;
        await db.SaveChangesAsync(ct);
        return new KanbanSyncResult(0, 0, 0, board.SyncError);
    }

    /// <summary>Who's who: each person's tracker account, both ways.</summary>
    private sealed record People(Dictionary<Guid, string> AccountOf, Dictionary<string, Guid> PersonOf);

    private sealed record SyncContext(
        KanbanDoc.State State, Dictionary<string, KanbanTask> Rows, IReadOnlyList<BoardStatus> Statuses, Dictionary<string, string> StatusMap, People People)
    {
        public KanbanDoc.Task? TaskOfIssue(BoardIssue issue) =>
            State.Tasks.Values.FirstOrDefault(t => t.ExtId == issue.Id) ?? State.Tasks.Values.FirstOrDefault(t => t.ExtKey == issue.Key);

        public KanbanDoc.Task? TaskOfKey(string? extKey) => extKey is null ? null : State.Tasks.Values.FirstOrDefault(t => t.ExtKey == extKey);

        /// <summary>The column an issue in this status goes in.</summary>
        public string ColumnOf(BoardIssue issue) =>
            StatusMap.TryGetValue(issue.StatusId, out var column) && State.Columns.Any(c => c.Id == column) ? column
            : (State.Columns.FirstOrDefault(c => c.Category == issue.StatusCategory) ?? State.Columns[0]).Id;

        /// <summary>The status a task in this column should be in: one mapped to it, else the first of the same kind.</summary>
        public string StatusOf(KanbanDoc.Task task, string? current)
        {
            var column = State.ColumnOf(task);
            if (column is null)
            {
                return current ?? "";
            }

            // Already in a status that goes in this column: leave it.
            if (current is not null && StatusMap.TryGetValue(current, out var mapped) && mapped == column.Id)
            {
                return current;
            }

            return StatusMap.FirstOrDefault(m => m.Value == column.Id).Key
                ?? Statuses.FirstOrDefault(s => s.Category == column.Category)?.Id ?? current ?? "";
        }

        /// <summary>The task's fields in the tracker's terms. An assignee with no account in the tracker counts as unchanged.</summary>
        public Fields Local(KanbanDoc.Task task, Fields? synced)
        {
            var first = task.AssigneeIds.FirstOrDefault();
            var assignee = first == Guid.Empty ? null
                : People.AccountOf.TryGetValue(first, out var account) ? account
                : synced?.Assignee;
            var parent = task.Parent is { } p && State.Tasks.TryGetValue(p, out var parentTask) ? parentTask.ExtKey : null;
            var links = State.Relations.Where(r => r.From == task.Id)
                .Select(r => State.Tasks.TryGetValue(r.To, out var other) && other.ExtKey is { } key ? $"{r.Type}:{key}" : null)
                .OfType<string>().Order(StringComparer.Ordinal).ToList();
            return new Fields(
                task.Title, task.Description.TrimEnd(), StatusOf(task, synced?.Status), assignee, task.Due, Labels(task.Tags), task.Priority, task.Type,
                parent, links);
        }
    }

    private static List<string> Labels(IEnumerable<string> labels) =>
        [.. labels.Select(l => DocAppearance.NormalizeTag(l.Replace(' ', '-'), out _)).OfType<string>().Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];

    private static Fields Remote(BoardIssue issue) => new(
        issue.Title, issue.Description.TrimEnd(), issue.StatusId, issue.AssigneeAccountId, issue.Due, Labels(issue.Labels),
        issue.Priority is { } p && KanbanDoc.Priorities.Contains(p) ? p : "medium", issue.Type, issue.ParentKey,
        [.. issue.Links.Where(l => l.Outward || l.Type == "relates").Select(l => $"{l.Type}:{l.OtherKey}").Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)]);

    private static readonly string[] FieldNames = ["title", "description", "status", "assignee", "due", "labels", "priority", "type", "parent", "links"];

    private static object? Get(Fields f, string name) => name switch
    {
        "title" => f.Title,
        "description" => f.Description,
        "status" => f.Status,
        "assignee" => f.Assignee,
        "due" => f.Due,
        "labels" => string.Join(',', f.Labels),
        "priority" => f.Priority,
        "type" => f.Type,
        "parent" => f.Parent,
        "links" => string.Join(',', f.Links),
        _ => null,
    };

    private static bool Same(Fields? a, Fields b, string name) => a is not null && Equals(Get(a, name), Get(b, name));

    /* ------------------------------------------------------------------ from the tracker */

    private static void Pull(Plan plan, SyncContext context, IReadOnlyList<BoardIssue> issues, string direction)
    {
        foreach (var issue in issues)
        {
            var remote = Remote(issue);
            var task = context.TaskOfIssue(issue);
            if (task is null)
            {
                if (context.State.Tasks.Count + plan.NewTasks.Count >= KanbanEndpoints.MaxTasks)
                {
                    plan.Error ??= $"The kanban is full ({KanbanEndpoints.MaxTasks} tasks): some issues weren't brought in.";
                    continue;
                }

                var created = new KanbanDoc.Task { Id = Guid.NewGuid().ToString() };
                plan.NewTasks.Add((created, issue));
                plan.Synced[created.Id] = remote;
                plan.Columns[created.Id] = context.ColumnOf(issue);
                continue;
            }

            var synced = Fields.Parse(context.Rows.GetValueOrDefault(task.Id)?.SyncedFields);
            var local = context.Local(task, synced);
            var localNewer = DateTime.TryParse(task.UpdatedAt, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var edited)
                && edited > issue.Updated;
            var take = new HashSet<string>(StringComparer.Ordinal);
            foreach (var name in FieldNames)
            {
                var remoteChanged = !Same(synced, remote, name);
                var localChanged = !Same(synced, local, name);
                if (Equals(Get(local, name), Get(remote, name)) || !remoteChanged)
                {
                    continue;
                }

                // Changed on both sides: the later edit wins. First sync of a pair (no record of either): the tracker's.
                if (!localChanged || synced is null || !localNewer || direction == KanbanSyncDirections.FromTracker)
                {
                    take.Add(name);
                }
            }

            if (take.Count > 0)
            {
                plan.Local[task.Id] = (task, take);
                if (take.Contains("status"))
                {
                    plan.Columns[task.Id] = context.ColumnOf(issue);
                }
            }

            // Fields taken from the tracker are synced as the tracker has them; the rest stay as last synced, so the push below
            // sees what changed here.
            plan.Synced[task.Id] = Merge(synced ?? local, remote, take);
        }
    }

    private static Fields Merge(Fields local, Fields remote, HashSet<string> fromRemote) => new(
        fromRemote.Contains("title") ? remote.Title : local.Title,
        fromRemote.Contains("description") ? remote.Description : local.Description,
        fromRemote.Contains("status") ? remote.Status : local.Status,
        fromRemote.Contains("assignee") ? remote.Assignee : local.Assignee,
        fromRemote.Contains("due") ? remote.Due : local.Due,
        fromRemote.Contains("labels") ? remote.Labels : local.Labels,
        fromRemote.Contains("priority") ? remote.Priority : local.Priority,
        fromRemote.Contains("type") ? remote.Type : local.Type,
        fromRemote.Contains("parent") ? remote.Parent : local.Parent,
        fromRemote.Contains("links") ? remote.Links : local.Links);

    /* ------------------------------------------------------------------ to the tracker */

    private async Task PushAsync(
        Plan plan, SyncContext context, IBoardSync tracker, TrackerSettings settings, TrackerToken token, KanbanBoard board, IReadOnlyList<BoardIssue> issues,
        CancellationToken ct)
    {
        var byKey = issues.ToDictionary(i => i.Key, StringComparer.Ordinal);
        foreach (var task in context.State.Ordered())
        {
            try
            {
                if (task.ExtKey is null)
                {
                    await CreateAsync(plan, context, tracker, settings, token, board, task, ct);
                    continue;
                }

                var synced = plan.Synced.GetValueOrDefault(task.Id) ?? Fields.Parse(context.Rows.GetValueOrDefault(task.Id)?.SyncedFields);
                if (synced is null)
                {
                    continue; // paired, but its issue hasn't come by since: it will
                }

                var local = context.Local(task, synced);
                var taken = plan.Local.GetValueOrDefault(task.Id).Fields ?? [];
                var changed = FieldNames.Where(n => !taken.Contains(n) && !Same(synced, local, n)).ToHashSet(StringComparer.Ordinal);
                if (changed.Count == 0)
                {
                    continue;
                }

                await PushFieldsAsync(tracker, settings, token, task.ExtKey, local, synced, changed, byKey.GetValueOrDefault(task.ExtKey), ct);
                plan.Synced[task.Id] = Merge(synced, local, changed);
                plan.Pushed++;
            }
            catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException)
            {
                plan.Error ??= $"{task.Key}: {ex.Message}";
            }
        }
    }

    private async Task PushFieldsAsync(
        IBoardSync tracker, TrackerSettings settings, TrackerToken token, string key, Fields local, Fields? before, HashSet<string> changed, BoardIssue? issue,
        CancellationToken ct)
    {
        var change = new BoardChange(
            Title: changed.Contains("title") ? local.Title : null,
            Description: changed.Contains("description") ? local.Description : null,
            SetDue: changed.Contains("due"), Due: local.Due,
            Labels: changed.Contains("labels") ? local.Labels : null,
            Priority: changed.Contains("priority") ? local.Priority : null,
            SetAssignee: changed.Contains("assignee"), Assignee: local.Assignee);
        await accounts.WithAsync(token, async t =>
        {
            await tracker.UpdateAsync(settings, t, key, change, ct);
            return true;
        }, ct);
        if (changed.Contains("status") && local.Status.Length > 0 && local.Status != issue?.StatusId)
        {
            await accounts.WithAsync(token, async t =>
            {
                await tracker.TransitionAsync(settings, t, key, local.Status, ct);
                return true;
            }, ct);
        }

        if (changed.Contains("links"))
        {
            foreach (var link in local.Links.Except(before?.Links ?? [], StringComparer.Ordinal))
            {
                var (type, other) = (link[..link.IndexOf(':')], link[(link.IndexOf(':') + 1)..]);
                await accounts.WithAsync(token, async t =>
                {
                    await tracker.LinkAsync(settings, t, type, key, other, ct);
                    return true;
                }, ct);
            }
        }
    }

    /// <summary>A task new on the kanban: its issue, with its fields. Tasks from before the kanban was connected only if asked.</summary>
    private async Task CreateAsync(
        Plan plan, SyncContext context, IBoardSync tracker, TrackerSettings settings, TrackerToken token, KanbanBoard board, KanbanDoc.Task task,
        CancellationToken ct)
    {
        var created = DateTime.TryParse(task.CreatedAt, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var at)
            ? at : DateTime.MinValue;
        if (!board.PushExisting && (board.ConnectedAt is null || created < board.ConnectedAt))
        {
            return;
        }

        var parentKey = task.Parent is { } p && context.State.Tasks.TryGetValue(p, out var parent) ? parent.ExtKey : null;
        if (task.Parent is not null && parentKey is null)
        {
            return; // its parent goes first; this one next time
        }

        var issue = await accounts.WithAsync(token, t => tracker.CreateTaskAsync(settings, t, task.Title, task.Description, task.Type, parentKey, ct), ct);
        task.ExtId = issue.ExternalId;
        task.ExtKey = issue.Key;
        task.ExtUrl = issue.Url;
        plan.Local[task.Id] = (task, ["ext"]);
        plan.Created++;

        // The rest of its fields, as for any change.
        var local = context.Local(task, null);
        var empty = new Fields(local.Title, local.Description, "", null, null, [], "medium", local.Type, parentKey, []);
        var changed = FieldNames.Where(n => !Same(empty, local, n) && n is not ("title" or "description" or "type" or "parent")).ToHashSet(StringComparer.Ordinal);
        await PushFieldsAsync(tracker, settings, token, issue.Key, local, empty, changed, null, ct);
        plan.Synced[task.Id] = local;
    }

    /* ------------------------------------------------------------------ onto the kanban */

    private async Task ApplyAsync(Guid kanbanId, Guid userId, Plan plan, CancellationToken ct)
    {
        if (plan.Local.Count == 0 && plan.NewTasks.Count == 0 && plan.Synced.Count == 0)
        {
            return;
        }

        var keys = plan.NewTasks.Count == 0 ? null : await KanbanEndpoints.ReserveAsync(db, kanbanId, plan.NewTasks.Count, ct);
        var now = clock.GetUtcNow().UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
        if (plan.Local.Count > 0 || plan.NewTasks.Count > 0)
        {
            await editor.ApplyAsync(kanbanId, userId, (ydoc, state) =>
            {
                var people = plan.PeopleByAccount;
                ApplyNewTasks(ydoc, state, plan, keys, now);
                foreach (var (id, (planned, fields)) in plan.Local)
                {
                    if (!state.Tasks.TryGetValue(id, out var task) || !plan.Synced.TryGetValue(id, out var remote))
                    {
                        continue;
                    }

                    var written = Write(task, planned, plan.Columns.GetValueOrDefault(id), remote, fields, state, people);
                    if (written.Count > 0)
                    {
                        task.UpdatedAt = now;
                        written.Add("updatedAt");
                        KanbanDoc.Update(ydoc, task, written);
                    }

                    if (fields.Contains("links"))
                    {
                        AddRelations(ydoc, state, task, remote, plan);
                    }
                }

                foreach (var relation in plan.NewRelations)
                {
                    KanbanDoc.AddRelation(ydoc, relation);
                }

                return Task.FromResult(true);
            }, ct);
        }

        // What both sides now agree on, for next time. Rows for new tasks were made when the change above was saved.
        var ids = plan.Synced.Keys.ToList();
        var rows = await db.KanbanTasks.Where(t => t.DocId == kanbanId && ids.Contains(t.TaskId)).ToListAsync(ct);
        foreach (var row in rows)
        {
            row.SyncedFields = plan.Synced[row.TaskId].ToJson();
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>Copies the tracker's fields onto a task; returns the Yjs fields to write.</summary>
    private static HashSet<string> Write(
        KanbanDoc.Task task, KanbanDoc.Task planned, string? column, Fields remote, HashSet<string> fields, KanbanDoc.State state, Dictionary<string, Guid> people)
    {
        var written = new HashSet<string>(StringComparer.Ordinal);
        if (fields.Contains("ext"))
        {
            (task.ExtId, task.ExtKey, task.ExtUrl) = (planned.ExtId, planned.ExtKey, planned.ExtUrl);
            written.UnionWith(["extId", "extKey", "extUrl"]);
        }

        if (fields.Contains("title") && remote.Title.Length > 0)
        {
            task.Title = remote.Title.Length > KanbanTask.MaxTitleLength ? remote.Title[..KanbanTask.MaxTitleLength] : remote.Title;
            written.Add("title");
        }

        if (fields.Contains("description"))
        {
            task.Description = remote.Description;
            written.Add("description");
        }

        if (fields.Contains("status") && column is not null && column != task.Column)
        {
            task.Column = column;
            task.Rank = Ranks.Between(state.Tasks.Values.Where(t => t.Column == task.Column && t.Id != task.Id).Select(t => t.Rank).DefaultIfEmpty("").Max(StringComparer.Ordinal), null);
            written.UnionWith(["column", "rank"]);
        }

        if (fields.Contains("assignee"))
        {
            task.Assignees = remote.Assignee is { } account && people.TryGetValue(account, out var person) ? [person.ToString()] : [];
            written.Add("assignees");
        }

        if (fields.Contains("due"))
        {
            task.Due = remote.Due;
            written.Add("due");
        }

        if (fields.Contains("labels"))
        {
            task.Tags = [.. remote.Labels];
            written.Add("tags");
        }

        if (fields.Contains("priority"))
        {
            task.Priority = remote.Priority;
            written.Add("priority");
        }

        if (fields.Contains("type"))
        {
            task.Type = remote.Type;
            written.Add("type");
        }

        if (fields.Contains("parent"))
        {
            task.Parent = remote.Parent is { } key ? state.Tasks.Values.FirstOrDefault(t => t.ExtKey == key)?.Id : null;
            written.Add("parent");
        }

        return written;
    }

    private static void ApplyNewTasks(YDotNet.Document.Doc ydoc, KanbanDoc.State state, Plan plan, ReservedKeysResponse? keys, string now)
    {
        var people = plan.PeopleByAccount;
        for (var i = 0; i < plan.NewTasks.Count; i++)
        {
            var (task, issue) = plan.NewTasks[i];
            var remote = plan.Synced[task.Id];
            task.Key = $"{keys!.Prefix}-{keys.First + i}";
            task.Title = issue.Title.Length > 0 ? issue.Title : issue.Key;
            task.Description = remote.Description;
            task.Column = plan.Columns.GetValueOrDefault(task.Id) ?? state.Columns[0].Id;
            task.Rank = Ranks.Between(state.Tasks.Values.Where(t => t.Column == task.Column).Select(t => t.Rank).DefaultIfEmpty("").Max(StringComparer.Ordinal), null);
            task.Type = remote.Type;
            task.Priority = remote.Priority;
            task.Assignees = remote.Assignee is { } account && people.TryGetValue(account, out var person) ? [person.ToString()] : [];
            task.Tags = [.. remote.Labels];
            task.Due = remote.Due;
            task.ExtId = issue.Id;
            task.ExtKey = issue.Key;
            task.ExtUrl = issue.Url;
            task.CreatedAt = now;
            task.UpdatedAt = now;
            KanbanDoc.Insert(ydoc, task);
            state.Tasks[task.Id] = task;
        }

        // Parents and links once every new task is in.
        foreach (var (task, issue) in plan.NewTasks)
        {
            if (issue.ParentKey is { } parentKey && state.Tasks.Values.FirstOrDefault(t => t.ExtKey == parentKey) is { } parent)
            {
                task.Parent = parent.Id;
                KanbanDoc.Update(ydoc, task, ["parent"]);
            }

            AddRelations(ydoc, state, task, plan.Synced[task.Id], plan);
        }
    }

    /// <summary>The tracker's links from this task to others on the kanban that it doesn't have yet.</summary>
    private static void AddRelations(YDotNet.Document.Doc ydoc, KanbanDoc.State state, KanbanDoc.Task task, Fields remote, Plan plan)
    {
        foreach (var link in remote.Links)
        {
            var (type, key) = (link[..link.IndexOf(':')], link[(link.IndexOf(':') + 1)..]);
            if (state.Tasks.Values.FirstOrDefault(t => t.ExtKey == key) is not { } other || other.Id == task.Id)
            {
                continue;
            }

            var exists = state.Relations.Concat(plan.NewRelations)
                .Any(r => r.Type == type && ((r.From == task.Id && r.To == other.Id) || (type == "relates" && r.From == other.Id && r.To == task.Id)));
            if (!exists)
            {
                plan.NewRelations.Add(new KanbanDoc.Relation(Guid.NewGuid().ToString(), task.Id, other.Id, type));
            }
        }
    }

    /* ------------------------------------------------------------------ people */

    /// <summary>The tracker accounts of everyone a task on the kanban can be assigned to (looked up by email, kept an hour).</summary>
    private async Task<People> PeopleAsync(Guid connectionId, Guid kanbanId, IBoardSync tracker, TrackerSettings settings, TrackerToken token, CancellationToken ct)
    {
        var orgIds = await db.DocOrgShares.AsNoTracking().Where(s => s.DocId == kanbanId).Select(s => s.OrganizationId).ToListAsync(ct);
        orgIds.Add(await db.Docs.AsNoTracking().Where(d => d.Id == kanbanId).Select(d => d.OrganizationId).SingleAsync(ct));
        var people = await db.OrganizationMembers.AsNoTracking().Where(m => orgIds.Contains(m.OrganizationId) && !m.User!.IsDisabled)
            .Select(m => new { m.User!.Id, m.User.Email }).Distinct().Take(200).ToListAsync(ct);
        var accountOf = new Dictionary<Guid, string>();
        var now = clock.GetUtcNow().UtcDateTime;
        foreach (var person in people.Where(p => !string.IsNullOrEmpty(p.Email)))
        {
            var key = (connectionId, person.Email.ToLowerInvariant());
            if (!Accounts.TryGetValue(key, out var known) || now - known.At > AccountsFor)
            {
                string? found = null;
                try
                {
                    found = await accounts.WithAsync(token, t => tracker.FindAccountAsync(settings, t, person.Email, ct), ct);
                }
                catch (HttpRequestException)
                {
                    // Not allowed to look people up: no one matches.
                }

                known = (found, now);
                Accounts[key] = known;
            }

            if (known.AccountId is { } account)
            {
                accountOf[person.Id] = account;
            }
        }

        return new People(accountOf, accountOf.GroupBy(a => a.Value).ToDictionary(g => g.Key, g => g.First().Key, StringComparer.Ordinal));
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Syncing kanban {KanbanId} with its tracker failed")]
    private static partial void LogFailed(ILogger logger, Exception ex, Guid kanbanId);
}
