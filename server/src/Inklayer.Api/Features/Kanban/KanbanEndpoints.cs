using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Features.Notifications;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Kanban;

/// <param name="Count">How many keys to reserve, 1 to 100.</param>
public sealed record ReserveKeysRequest(int Count = 1);

/// <summary>Keys for new tasks: <c>{Prefix}-{First}</c> to <c>{Prefix}-{First + Count - 1}</c>, given to no one else.</summary>
public sealed record ReservedKeysResponse(string Prefix, long First, int Count);

/// <param name="Tracker">The tracker it syncs with, if any.</param>
public sealed record KanbanSettingsResponse(Guid Id, string KeyPrefix, bool CanManage, KanbanTrackerResponse? Tracker);

/// <param name="ConnectionId">The project's tracker connection.</param>
/// <param name="StatusMap">The tracker's status id → the kanban's column id.</param>
public sealed record KanbanTrackerResponse(
    Guid ConnectionId, Guid ProjectId, string ProjectName, string Kind, string Name, IReadOnlyDictionary<string, string> StatusMap,
    [property: AllowedValues(KanbanSyncDirections.Both, KanbanSyncDirections.FromTracker)] string Direction, DateTime? SyncedAt, string? SyncError);

/// <param name="KeyPrefix">The prefix of new tasks' keys. Tasks that have keys keep them.</param>
public sealed record UpdateKanbanSettingsRequest(string? KeyPrefix);

/// <summary>A task on a kanban, as the server last saw it.</summary>
/// <param name="Category">The kind of column it's in: todo, doing or done.</param>
/// <param name="Due">yyyy-mm-dd.</param>
public sealed record TaskSummaryResponse(
    Guid KanbanId, string KanbanTitle, Guid OrganizationId, string TaskId, string Key, string Title, string Column,
    [property: AllowedValues(KanbanCategories.Todo, KanbanCategories.Doing, KanbanCategories.Done)] string Category, string Type, string Priority,
    DateOnly? Due, IReadOnlyList<PersonResponse> Assignees, IReadOnlyList<string> Tags, string? ParentTaskId, Guid? LinkedDocId,
    string? ExternalKey, string? ExternalUrl, DateTime UpdatedAt);

/// <summary>A doc that links a task with <c>[[task:WEB-12]]</c>.</summary>
public sealed record TaskMentionResponse(Guid DocId, Guid OrganizationId, string Folder, string Title);

/// <summary>
/// What kanbans need beyond the docs hub: unique task keys, settings, the people tasks can be given to, and the tasks across
/// kanbans ("My tasks", links to a task from a doc). A kanban is a doc of kind "kanban"; its columns and tasks are in its Yjs
/// document (see <see cref="KanbanDoc"/>).
/// </summary>
internal static class KanbanEndpoints
{
    public const int MaxTasks = 2000;

    public static IEndpointRouteBuilder MapKanbanEndpoints(this IEndpointRouteBuilder app)
    {
        var kanbans = app.MapGroup("/api/kanbans").WithTags("Kanban").RequireAuthorization();
        kanbans.MapPost("/{kanbanId:guid}/keys", ReserveKeysAsync).Produces<ReservedKeysResponse>()
            .WithSummary("Reserve keys for new tasks (Commenter and above), so two people adding tasks at once never get the same key");
        kanbans.MapGet("/{kanbanId:guid}/settings", SettingsAsync).Produces<KanbanSettingsResponse>().WithSummary("The kanban's key prefix and tracker sync");
        kanbans.MapPut("/{kanbanId:guid}/settings", UpdateSettingsAsync).Produces<KanbanSettingsResponse>()
            .WithSummary("Change the prefix of new tasks' keys (Commenter and above in the kanban's organisation)");
        kanbans.MapGet("/{kanbanId:guid}/people", PeopleAsync).Produces<List<PersonResponse>>()
            .WithSummary("Everyone a task on the kanban can be assigned to: members of its organisation and of those it's shared with");
        kanbans.MapGet("/{kanbanId:guid}/tasks", BoardTasksAsync).Produces<List<TaskSummaryResponse>>().WithSummary("The kanban's tasks, as of its last save");
        kanbans.MapGet("/{kanbanId:guid}/mentions", MentionsAsync).Produces<List<TaskMentionResponse>>()
            .WithSummary("The docs (that the caller can open) that link one of the kanban's tasks with [[task:KEY]]: ?key=WEB-12");

        var orgs = app.MapGroup("/api/orgs/{orgId:guid}/tasks").WithTags("Kanban").RequireAuthorization();
        orgs.MapGet("", TasksAsync).Produces<List<TaskSummaryResponse>>()
            .WithSummary("Tasks across the organisation's kanbans (and those shared with it): ?assignee=me, ?status=open|done|all, ?tag=, ?due=overdue|week, ?q=");
        orgs.MapGet("/{key}", TaskByKeyAsync).Produces<TaskSummaryResponse>().WithSummary("A task by its key, e.g. WEB-12, for links to it from docs");
        return app;
    }

    /// <summary>Null when <paramref name="kanbanId"/> is a kanban the caller has <paramref name="permission"/> on; otherwise the answer to give.</summary>
    internal static async Task<IResult?> KanbanAsync(Guid kanbanId, Permission permission, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (!await db.Docs.AsNoTracking().AnyAsync(d => d.Id == kanbanId && d.DeletedAt == null && d.Kind == DocKinds.Kanban, ct))
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckDocAsync(kanbanId, permission, ct);
        return check.IsAllowed ? null : check.Denied!;
    }

    /// <summary>The kanban's own row; made if it's missing (a kanban restored from before it had one).</summary>
    internal static async Task<KanbanBoard> BoardRowAsync(InklayerDbContext db, Guid kanbanId, CancellationToken ct)
    {
        if (await db.KanbanBoards.SingleOrDefaultAsync(k => k.DocId == kanbanId, ct) is { } row)
        {
            return row;
        }

        var doc = await db.Docs.AsNoTracking().Where(d => d.Id == kanbanId).Select(d => new { d.OrganizationId, d.Title }).SingleAsync(ct);
        row = new KanbanBoard { DocId = kanbanId, OrganizationId = doc.OrganizationId, KeyPrefix = await FreePrefixAsync(db, doc.OrganizationId, KanbanBoard.PrefixFrom(doc.Title), ct) };
        db.KanbanBoards.Add(row);
        await db.SaveChangesAsync(ct);
        return row;
    }

    /// <summary><paramref name="wanted"/>, or with a number after it (<c>WEB2</c>) if another kanban in the organisation has it.</summary>
    internal static async Task<string> FreePrefixAsync(InklayerDbContext db, Guid orgId, string wanted, CancellationToken ct)
    {
        var taken = await db.KanbanBoards.AsNoTracking().Where(k => k.OrganizationId == orgId).Select(k => k.KeyPrefix).ToListAsync(ct);
        if (!taken.Contains(wanted))
        {
            return wanted;
        }

        for (var n = 2; ; n++)
        {
            var candidate = wanted[..Math.Min(wanted.Length, KanbanBoard.MaxKeyPrefixLength - n.ToString(System.Globalization.CultureInfo.InvariantCulture).Length)] + n;
            if (!taken.Contains(candidate))
            {
                return candidate;
            }
        }
    }

    /// <summary>Hands out <paramref name="count"/> numbers in one statement, so no two callers get the same.</summary>
    internal static async Task<ReservedKeysResponse> ReserveAsync(InklayerDbContext db, Guid kanbanId, int count, CancellationToken ct)
    {
        var row = await BoardRowAsync(db, kanbanId, ct);
        var next = await db.Database.SqlQuery<long>(
                $"UPDATE KanbanBoards SET NextNumber = NextNumber + {count} WHERE DocId = {kanbanId} RETURNING NextNumber AS Value")
            .ToListAsync(ct);
        return new ReservedKeysResponse(row.KeyPrefix, next.Single() - count, count);
    }

    private static async Task<IResult> ReserveKeysAsync(Guid kanbanId, ReserveKeysRequest request, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanAsync(kanbanId, Permission.Comment, access, db, ct) is { } denied)
        {
            return denied;
        }

        if (request.Count is < 1 or > 100)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["count"] = ["Reserve between 1 and 100 keys."] });
        }

        // The prefix can change meanwhile; what's returned is read with the numbers.
        var reserved = await ReserveAsync(db, kanbanId, request.Count, ct);
        var prefix = await db.KanbanBoards.AsNoTracking().Where(k => k.DocId == kanbanId).Select(k => k.KeyPrefix).SingleAsync(ct);
        return TypedResults.Ok(reserved with { Prefix = prefix });
    }

    private static async Task<IResult> SettingsAsync(Guid kanbanId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanAsync(kanbanId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        return TypedResults.Ok(await DescribeSettingsAsync(db, kanbanId, currentUser.Id!.Value, ct));
    }

    internal static async Task<KanbanSettingsResponse> DescribeSettingsAsync(InklayerDbContext db, Guid kanbanId, Guid userId, CancellationToken ct)
    {
        var row = await BoardRowAsync(db, kanbanId, ct);
        var role = await DocAccess.RoleAsync(db, userId, kanbanId, includeDeleted: false, ct);
        var canManage = role?.HomeRole is { } home && home.Grants(Permission.Comment);
        KanbanTrackerResponse? tracker = null;
        if (row.TrackerConnectionId is { } connectionId)
        {
            tracker = await db.IssueTrackerConnections.AsNoTracking().Where(c => c.Id == connectionId)
                .Join(db.Projects, c => c.ProjectId, p => p.Id, (c, p) => new { c.Id, c.ProjectId, ProjectName = p.Name, c.Kind, c.Name })
                .Select(c => new KanbanTrackerResponse(c.Id, c.ProjectId, c.ProjectName, c.Kind, c.Name, new Dictionary<string, string>(), row.SyncDirection, row.SyncedAt, row.SyncError))
                .SingleOrDefaultAsync(ct);
            tracker = tracker is null ? null : tracker with { StatusMap = KanbanSync.ParseStatusMap(row.StatusMap) };
        }

        return new KanbanSettingsResponse(kanbanId, row.KeyPrefix, canManage, tracker);
    }

    private static async Task<IResult> UpdateSettingsAsync(
        Guid kanbanId, UpdateKanbanSettingsRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanAsync(kanbanId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        var row = await BoardRowAsync(db, kanbanId, ct);
        var role = await DocAccess.RoleAsync(db, currentUser.Id!.Value, kanbanId, includeDeleted: false, ct);
        if (role?.HomeRole is not { } home || !home.Grants(Permission.Comment))
        {
            return TypedResults.Forbid();
        }

        if (request.KeyPrefix is { } wanted)
        {
            var prefix = wanted.Trim().ToUpperInvariant();
            if (!KanbanBoard.IsValidPrefix(prefix))
            {
                return TypedResults.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["keyPrefix"] = ["A key prefix is 2 to 10 capital letters or digits, starting with a letter."],
                });
            }

            if (prefix != row.KeyPrefix && await db.KanbanBoards.AnyAsync(k => k.OrganizationId == row.OrganizationId && k.KeyPrefix == prefix, ct))
            {
                return TypedResults.Conflict(new { title = $"Another kanban in this organisation already uses {prefix}." });
            }

            row.KeyPrefix = prefix;
            await db.SaveChangesAsync(ct);
        }

        return TypedResults.Ok(await DescribeSettingsAsync(db, kanbanId, currentUser.Id!.Value, ct));
    }

    private static async Task<IResult> PeopleAsync(Guid kanbanId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanAsync(kanbanId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        var orgId = await db.Docs.AsNoTracking().Where(d => d.Id == kanbanId).Select(d => d.OrganizationId).SingleAsync(ct);
        var orgIds = await db.DocOrgShares.AsNoTracking().Where(s => s.DocId == kanbanId).Select(s => s.OrganizationId).ToListAsync(ct);
        orgIds.Add(orgId);
        var people = await db.OrganizationMembers.AsNoTracking().Where(m => orgIds.Contains(m.OrganizationId) && !m.User!.IsDisabled)
            .Select(m => new { m.User!.Id, m.User.DisplayName, m.User.PreferredName })
            .Distinct().Take(1000).ToListAsync(ct);
        return TypedResults.Ok(people.OrderBy(p => p.PreferredName ?? p.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Select(p => new PersonResponse(p.Id, p.PreferredName ?? p.DisplayName, p.DisplayName)).ToList());
    }

    private static async Task<IResult> BoardTasksAsync(Guid kanbanId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanAsync(kanbanId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        return TypedResults.Ok(await DescribeAsync(db, db.KanbanTasks.Where(t => t.DocId == kanbanId), MaxTasks, ct));
    }

    private static async Task<IResult> MentionsAsync(Guid kanbanId, string key, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanAsync(kanbanId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        var linkKey = DocIndexer.TaskLinkKey(key.Trim());
        var docs = await db.DocLinks.AsNoTracking().Where(l => l.TargetDocId == kanbanId && l.TargetKey == linkKey && l.SourceDocId != null)
            .Join(db.Docs.Where(d => d.DeletedAt == null), l => l.SourceDocId, d => d.Id, (l, d) => new TaskMentionResponse(d.Id, d.OrganizationId, d.Folder, d.Title))
            .Distinct().Take(100).ToListAsync(ct);
        var visible = await DocAccess.VisibleAsync(db, currentUser.Id!.Value, [.. docs.Select(d => d.DocId)], ct);
        return TypedResults.Ok(docs.Where(d => visible.Contains(d.DocId)).OrderBy(d => d.Title, StringComparer.OrdinalIgnoreCase).ToList());
    }

    internal static async Task<IResult> TasksAsync(
        Guid orgId, string? assignee, string? status, string? tag, string? due, string? q, int? limit,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var userId = currentUser.Id!.Value;
        var query = VisibleTasks(db, orgId);
        if (assignee is { Length: > 0 })
        {
            var person = assignee == "me" ? userId : Guid.TryParse(assignee, out var id) ? id : Guid.Empty;
            query = query.Where(t => t.Assignees.Any(a => a.UserId == person));
        }

        query = status switch
        {
            "done" => query.Where(t => t.Category == KanbanCategories.Done),
            "all" => query,
            _ => query.Where(t => t.Category != KanbanCategories.Done),
        };
        if (tag is { Length: > 0 })
        {
            var normal = DocAppearance.NormalizeTag(tag, out _) ?? "";
            query = query.Where(t => t.Tags.Any(x => x.Tag == normal));
        }

        var today = DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);
        if (due == "overdue")
        {
            query = query.Where(t => t.Due != null && t.Due < today);
        }
        else if (due == "week")
        {
            var week = today.AddDays(7);
            query = query.Where(t => t.Due != null && t.Due <= week);
        }

        if (q is { Length: > 0 })
        {
            // SQLite's LIKE ignores case (for ASCII letters).
            var pattern = "%" + q.Trim().Replace("\\", "\\\\", StringComparison.Ordinal).Replace("%", "\\%", StringComparison.Ordinal).Replace("_", "\\_", StringComparison.Ordinal) + "%";
            query = query.Where(t => EF.Functions.Like(t.Title, pattern, "\\") || EF.Functions.Like(t.Key, pattern, "\\"));
        }

        var tasks = await DescribeAsync(db, query, Math.Clamp(limit ?? 100, 1, 500), ct);
        var visible = await DocAccess.VisibleAsync(db, userId, [.. tasks.Select(t => t.KanbanId).Distinct()], ct);
        return TypedResults.Ok(tasks.Where(t => visible.Contains(t.KanbanId)).ToList());
    }

    private static async Task<IResult> TaskByKeyAsync(Guid orgId, string key, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var wanted = key.Trim().ToUpperInvariant();
        var found = await DescribeAsync(db, VisibleTasks(db, orgId).Where(t => t.Key == wanted), 10, ct);
        var visible = await DocAccess.VisibleAsync(db, currentUser.Id!.Value, [.. found.Select(t => t.KanbanId).Distinct()], ct);
        // The organisation's own kanban first: keys are unique within an organisation.
        var task = found.Where(t => visible.Contains(t.KanbanId)).OrderBy(t => t.OrganizationId == orgId ? 0 : 1).FirstOrDefault();
        return task is null ? TypedResults.NotFound() : TypedResults.Ok(task);
    }

    /// <summary>Tasks on kanbans that aren't deleted, in the organisation or shared with it.</summary>
    private static IQueryable<KanbanTask> VisibleTasks(InklayerDbContext db, Guid orgId) =>
        db.KanbanTasks.Where(t => db.Docs.Any(d => d.Id == t.DocId && d.DeletedAt == null && d.Kind == DocKinds.Kanban
            && (d.OrganizationId == orgId || db.DocOrgShares.Any(s => s.DocId == d.Id && s.OrganizationId == orgId))));

    internal static async Task<List<TaskSummaryResponse>> DescribeAsync(InklayerDbContext db, IQueryable<KanbanTask> query, int limit, CancellationToken ct)
    {
        var rows = await query.AsNoTracking().Include(t => t.Assignees).Include(t => t.Tags)
            .OrderBy(t => t.Due == null).ThenBy(t => t.Due).ThenByDescending(t => t.UpdatedAt)
            .Take(limit).AsSplitQuery().ToListAsync(ct);
        var docIds = rows.Select(r => r.DocId).Distinct().ToList();
        var titles = await db.Docs.AsNoTracking().Where(d => docIds.Contains(d.Id)).ToDictionaryAsync(d => d.Id, d => d.Title, ct);
        var userIds = rows.SelectMany(r => r.Assignees.Select(a => a.UserId)).Distinct().ToList();
        var people = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => new PersonResponse(u.Id, u.PreferredName ?? u.DisplayName, u.DisplayName), ct);
        return [.. rows.Select(t => new TaskSummaryResponse(
            t.DocId, titles.GetValueOrDefault(t.DocId, ""), t.OrganizationId, t.TaskId, t.Key, t.Title, t.ColumnName, t.Category, t.Type, t.Priority, t.Due,
            [.. t.Assignees.Select(a => people.GetValueOrDefault(a.UserId)).OfType<PersonResponse>()], [.. t.Tags.Select(x => x.Tag).Order(StringComparer.Ordinal)],
            t.ParentTaskId, t.LinkedDocId, t.ExternalKey, t.ExternalUrl, t.UpdatedAt))];
    }
}
