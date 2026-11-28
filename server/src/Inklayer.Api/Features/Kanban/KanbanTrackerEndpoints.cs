using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Issues;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Kanban;

/// <summary>A tracker connection a kanban can sync with: a Jira project connected to one of the organisation's products.</summary>
public sealed record KanbanTrackerChoiceResponse(Guid ConnectionId, Guid ProjectId, string ProjectName, string Kind, string Name, string? Site, string? ProjectKey);

/// <param name="Category">todo, doing or done.</param>
public sealed record TrackerStatusResponse(string Id, string Name, [property: AllowedValues("todo", "doing", "done")] string Category);

/// <param name="SuggestedMap">Status id → column id: by name, else the first column of the same kind.</param>
public sealed record KanbanTrackerStatusesResponse(IReadOnlyList<TrackerStatusResponse> Statuses, IReadOnlyDictionary<string, string> SuggestedMap);

/// <param name="StatusMap">Status id → column id; statuses left out go by name, then kind.</param>
/// <param name="AddColumns">Add a column for each status that has none of its name, and put it there.</param>
/// <param name="PushExisting">Also create issues for the tasks already on the kanban.</param>
public sealed record ConnectKanbanTrackerRequest(
    Guid ConnectionId, [property: AllowedValues(KanbanSyncDirections.Both, KanbanSyncDirections.FromTracker)] string Direction = KanbanSyncDirections.Both,
    IReadOnlyDictionary<string, string>? StatusMap = null, bool AddColumns = false, bool PushExisting = false);

public sealed record KanbanSyncResponse(KanbanSettingsResponse Settings, KanbanSyncResult? Result);

/// <summary>Connecting a kanban to a tracker's project (Jira), and syncing it now. See <see cref="KanbanSync"/>.</summary>
internal static class KanbanTrackerEndpoints
{
    public static IEndpointRouteBuilder MapKanbanTrackerEndpoints(this IEndpointRouteBuilder app)
    {
        var tracker = app.MapGroup("/api/kanbans/{kanbanId:guid}/tracker").WithTags("Kanban").RequireAuthorization();
        tracker.MapGet("/choices", ChoicesAsync).Produces<List<KanbanTrackerChoiceResponse>>()
            .WithSummary("The Jira connections of the organisation's products (that the caller can use) the kanban can sync with");
        tracker.MapGet("/statuses", StatusesAsync).Produces<KanbanTrackerStatusesResponse>()
            .WithSummary("A connection's statuses, and the columns they'd go in: ?connectionId=");
        tracker.MapPut("", ConnectAsync).Produces<KanbanSyncResponse>().WithSummary("Connect the kanban to a tracker and sync it straight away");
        tracker.MapDelete("", DisconnectAsync).Produces<KanbanSettingsResponse>().WithSummary("Stop syncing. Tasks keep their links to their issues.");
        tracker.MapPost("/sync", SyncNowAsync).Produces<KanbanSyncResponse>().WithSummary("Sync with the tracker now");
        return app;
    }

    /// <summary>Null when the caller may change the kanban's settings (Commenter and above in its own organisation).</summary>
    private static async Task<IResult?> ManageAsync(Guid kanbanId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await KanbanEndpoints.KanbanAsync(kanbanId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        var role = await DocAccess.RoleAsync(db, currentUser.Id!.Value, kanbanId, includeDeleted: false, ct);
        return role?.HomeRole is { } home && home.Grants(Permission.Comment) ? null : TypedResults.Forbid();
    }

    private static async Task<IResult> ChoicesAsync(Guid kanbanId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await ManageAsync(kanbanId, access, currentUser, db, ct) is { } denied)
        {
            return denied;
        }

        var orgId = await db.Docs.AsNoTracking().Where(d => d.Id == kanbanId).Select(d => d.OrganizationId).SingleAsync(ct);
        var connections = await db.IssueTrackerConnections.AsNoTracking().Where(c => c.OrganizationId == orgId && c.Kind == TrackerKinds.Jira)
            .Join(db.Projects, c => c.ProjectId, p => p.Id, (c, p) => new { Connection = c, ProjectName = p.Name })
            .ToListAsync(ct);
        var choices = new List<KanbanTrackerChoiceResponse>();
        foreach (var c in connections.OrderBy(c => c.ProjectName, StringComparer.OrdinalIgnoreCase).ThenBy(c => c.Connection.Name, StringComparer.OrdinalIgnoreCase))
        {
            if ((await access.CheckProjectAsync(c.Connection.ProjectId, Permission.Comment, ct)).IsAllowed)
            {
                var settings = IssueService.SettingsOf(c.Connection);
                choices.Add(new KanbanTrackerChoiceResponse(c.Connection.Id, c.Connection.ProjectId, c.ProjectName, c.Connection.Kind, c.Connection.Name, settings.Site, settings.ProjectKey));
            }
        }

        return TypedResults.Ok(choices);
    }

    /// <summary>The connection, if the caller can use it for this kanban (it's in the kanban's organisation, and they can comment on its product).</summary>
    private static async Task<IssueTrackerConnection?> ConnectionAsync(Guid kanbanId, Guid connectionId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var orgId = await db.Docs.AsNoTracking().Where(d => d.Id == kanbanId).Select(d => d.OrganizationId).SingleAsync(ct);
        var connection = await db.IssueTrackerConnections.AsNoTracking().SingleOrDefaultAsync(c => c.Id == connectionId && c.OrganizationId == orgId, ct);
        return connection is not null && (await access.CheckProjectAsync(connection.ProjectId, Permission.Comment, ct)).IsAllowed ? connection : null;
    }

    private static async Task<IResult> StatusesAsync(
        Guid kanbanId, Guid connectionId, AccessService access, CurrentUser currentUser, InklayerDbContext db, Trackers trackers, TrackerAccounts accounts,
        KanbanEditor editor, CancellationToken ct)
    {
        if (await ManageAsync(kanbanId, access, currentUser, db, ct) is { } denied)
        {
            return denied;
        }

        if (await ConnectionAsync(kanbanId, connectionId, access, db, ct) is not { } connection || trackers.For(connection.Kind) is not IBoardSync tracker)
        {
            return TypedResults.NotFound();
        }

        try
        {
            var token = await accounts.RequireForUserAsync(connection, currentUser.Id!.Value, ct);
            var statuses = await accounts.WithAsync(token, t => tracker.StatusesAsync(IssueService.SettingsOf(connection), t, ct), ct);
            var state = await editor.ReadAsync(kanbanId, ct);
            return TypedResults.Ok(new KanbanTrackerStatusesResponse(
                [.. statuses.Select(s => new TrackerStatusResponse(s.Id, s.Name, s.Category))],
                KanbanSync.DefaultStatusMap(statuses, state?.Columns ?? [])));
        }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException or TrackerAccountNeededException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: ex.Message);
        }
    }

    private static async Task<IResult> ConnectAsync(
        Guid kanbanId, ConnectKanbanTrackerRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, Trackers trackers,
        TrackerAccounts accounts, KanbanEditor editor, KanbanSync sync, TimeProvider clock, CancellationToken ct)
    {
        if (await ManageAsync(kanbanId, access, currentUser, db, ct) is { } denied)
        {
            return denied;
        }

        if (!KanbanSyncDirections.IsValid(request.Direction))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["direction"] = ["Sync both ways, or only from the tracker."] });
        }

        if (await ConnectionAsync(kanbanId, request.ConnectionId, access, db, ct) is not { } connection || trackers.For(connection.Kind) is not IBoardSync tracker)
        {
            return TypedResults.NotFound();
        }

        var userId = currentUser.Id!.Value;
        IReadOnlyList<BoardStatus> statuses;
        try
        {
            var token = await accounts.RequireForUserAsync(connection, userId, ct);
            statuses = await accounts.WithAsync(token, t => tracker.StatusesAsync(IssueService.SettingsOf(connection), t, ct), ct);
        }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException or TrackerAccountNeededException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: ex.Message);
        }

        // Columns for the statuses that have none of their name, if asked; then each status's column.
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        var state = await editor.ApplyAsync(kanbanId, userId, (ydoc, state) =>
        {
            var added = false;
            if (request.AddColumns)
            {
                var last = state.Columns.Count > 0 ? state.Columns[^1].Rank : null;
                foreach (var status in statuses.Where(s => !state.Columns.Any(c => string.Equals(c.Name.Trim(), s.Name.Trim(), StringComparison.OrdinalIgnoreCase))))
                {
                    // In workflow order, before the first done column for statuses that aren't done.
                    var doneAt = state.Columns.FindIndex(c => c.Category == KanbanCategories.Done);
                    var before = status.Category != KanbanCategories.Done && doneAt > 0 ? state.Columns[doneAt - 1].Rank : last;
                    var after = status.Category != KanbanCategories.Done && doneAt >= 0 ? state.Columns[doneAt].Rank : null;
                    var column = new KanbanDoc.Column(Guid.NewGuid().ToString(), status.Name, status.Category, Ranks.Between(before, after), null);
                    KanbanDoc.AddColumn(ydoc, column);
                    state.Columns.Insert(status.Category != KanbanCategories.Done && doneAt >= 0 ? doneAt : state.Columns.Count, column);
                    last = state.Columns[^1].Rank;
                    added = true;
                }
            }

            foreach (var (status, column) in KanbanSync.DefaultStatusMap(statuses, state.Columns))
            {
                map[status] = column;
            }

            return Task.FromResult(added);
        }, ct);

        foreach (var (status, column) in request.StatusMap ?? new Dictionary<string, string>())
        {
            if (statuses.Any(s => s.Id == status) && state?.Columns.Any(c => c.Id == column) == true)
            {
                map[status] = column;
            }
        }

        var board = await KanbanEndpoints.BoardRowAsync(db, kanbanId, ct);
        var reconnect = board.TrackerConnectionId == connection.Id;
        board.TrackerConnectionId = connection.Id;
        board.SyncDirection = request.Direction;
        board.StatusMap = KanbanSync.WriteStatusMap(map);
        board.PushExisting = request.PushExisting;
        board.ConnectedByUserId = userId;
        board.SyncError = null;
        if (!reconnect)
        {
            board.ConnectedAt = clock.GetUtcNow().UtcDateTime;
            board.SyncedAt = null; // a new project: bring in its open issues
        }

        await db.SaveChangesAsync(ct);
        var result = await sync.SyncAsync(kanbanId, ct);
        return TypedResults.Ok(new KanbanSyncResponse(await KanbanEndpoints.DescribeSettingsAsync(db, kanbanId, userId, ct), result));
    }

    private static async Task<IResult> DisconnectAsync(Guid kanbanId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await ManageAsync(kanbanId, access, currentUser, db, ct) is { } denied)
        {
            return denied;
        }

        var board = await KanbanEndpoints.BoardRowAsync(db, kanbanId, ct);
        (board.TrackerConnectionId, board.StatusMap, board.SyncedAt, board.SyncError, board.ConnectedAt) = (null, null, null, null, null);
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(await KanbanEndpoints.DescribeSettingsAsync(db, kanbanId, currentUser.Id!.Value, ct));
    }

    private static async Task<IResult> SyncNowAsync(Guid kanbanId, AccessService access, CurrentUser currentUser, InklayerDbContext db, KanbanSync sync, CancellationToken ct)
    {
        if (await KanbanEndpoints.KanbanAsync(kanbanId, Permission.Comment, access, db, ct) is { } denied)
        {
            return denied;
        }

        var result = await sync.SyncAsync(kanbanId, ct);
        return TypedResults.Ok(new KanbanSyncResponse(await KanbanEndpoints.DescribeSettingsAsync(db, kanbanId, currentUser.Id!.Value, ct), result));
    }
}
