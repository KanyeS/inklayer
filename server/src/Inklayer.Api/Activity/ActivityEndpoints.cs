using System.Text.Json;
using Inklayer.Api.Access;
using Inklayer.Api.Hosting;
using Inklayer.Api.Features.Live;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Activity;

public static class ActivityKinds
{
    public const string Comments = "comments";
    public const string SignIns = "signins";
    public const string Errors = "errors";
    public const string Docs = "docs";
}

public sealed record ActivityActor(Guid Id, string DisplayName, string? Email);

/// <summary>
/// One line of the activity log.
/// <list type="bullet">
/// <item><c>comments</c>: <see cref="Action"/> is created, updated, resolved, reopened, deleted or replied, with the page and project.</item>
/// <item><c>signins</c>: <see cref="Action"/> is signed_in or sign_in_refused.</item>
/// <item><c>errors</c>: <see cref="Action"/> is error; <see cref="Detail"/> says which request failed and why.</item>
/// <item><c>docs</c>: <see cref="Action"/> is created, edited, renamed, moved or deleted, with the doc and its organisation.</item>
/// </list>
/// </summary>
public sealed record ActivityItemResponse(
    string Id, string Kind, string Action, DateTime OccurredAt, ActivityActor? Actor,
    Guid? ProjectId, string? ProjectName, string? PageUrl, Guid? AnnotationId, string? Detail,
    Guid? DocId = null, string? DocTitle = null, Guid? OrganizationId = null);

/// <param name="Kinds">The kinds the caller is allowed to see.</param>
/// <param name="NextBefore">Pass as <c>?before=</c> to get the next, older page; null when there's nothing older.</param>
public sealed record ActivityResponse(IReadOnlyList<ActivityItemResponse> Items, IReadOnlyList<string> Kinds, DateTime? NextBefore);

/// <summary>
/// The activity log. What each person sees depends on their roles:
/// <list type="bullet">
/// <item>Everyone: comment activity (who did what, on which page) in the projects they can view, and doc activity in their organisations.</item>
/// <item>Organisation Admins and Owners: also sign-ins by members of those organisations.</item>
/// <item>Instance administrators: also refused sign-ins and server errors, which aren't tied to one organisation.</item>
/// </list>
/// </summary>
internal static class ActivityEndpoints
{
    private const int BodyPreviewLength = 140;

    public static IEndpointRouteBuilder MapActivityEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/activity", ListAsync).WithTags("Activity").RequireAuthorization()
            .WithSummary("Activity log, newest first. ?kind=comments|docs|signins|errors (default: all you can see), ?site=<origin> (comments on one site), ?before=<occurredAt>, ?limit=");
        return app;
    }

    internal static async Task<IResult> ListAsync(
        string? kind, string? site, DateTime? before, int? limit, CurrentUser currentUser, InklayerDbContext db, FeatureSwitches features, CancellationToken ct)
    {
        var user = await currentUser.GetAsync(ct);
        if (user is null || user.IsDisabled || await LiveEndpoints.VisibleProjectsAsync(currentUser, db, ct) is not { } visible)
        {
            return TypedResults.Unauthorized();
        }

        // Roles are stored as text, so compare by name rather than with >= in SQL.
        var adminOrgIds = user.IsSystemAdmin
            ? []
            : await db.OrganizationMembers.Where(m => m.UserId == user.Id && (m.Role == Role.Admin || m.Role == Role.Owner)).Select(m => m.OrganizationId).ToListAsync(ct);
        List<string> allowed = await features.IsEnabledAsync(Feature.Docs, ct) ? [ActivityKinds.Comments, ActivityKinds.Docs] : [ActivityKinds.Comments];
        if (user.IsSystemAdmin || adminOrgIds.Count > 0)
        {
            allowed.Add(ActivityKinds.SignIns);
        }

        if (user.IsSystemAdmin)
        {
            allowed.Add(ActivityKinds.Errors);
        }

        if (kind is not null && !allowed.Contains(kind))
        {
            return kind is ActivityKinds.SignIns or ActivityKinds.Errors
                ? TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only administrators can see that part of the activity log.")
                : TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["kind"] = ["Must be comments, docs, signins or errors."] });
        }

        string? siteOrigin = null;
        if (site is not null && (siteOrigin = Domain.Projects.LivePageUrl.OriginOf(site)) is null)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["site"] = ["Must be a web address like https://example.com."] });
        }

        // A site filter only applies to comments, so it shows just that site's comments.
        var kinds = kind is not null ? [kind] : siteOrigin is not null ? [ActivityKinds.Comments] : allowed;
        var take = Math.Clamp(limit ?? 50, 1, 200);
        var cursor = before is { } b ? (b.Kind == DateTimeKind.Utc ? b : b.ToUniversalTime()) : DateTime.MaxValue;
        var showEmails = allowed.Contains(ActivityKinds.SignIns);

        var items = new List<ActivityItemResponse>();
        if (kinds.Contains(ActivityKinds.Comments))
        {
            items.AddRange(await CommentsAsync(db, visible.ToDictionary(v => v.Project.Id, v => v.Project.Name), siteOrigin, cursor, take, showEmails, ct));
        }

        if (kinds.Contains(ActivityKinds.Docs))
        {
            var orgIds = user.IsSystemAdmin
                ? await db.Organizations.Select(o => o.Id).ToListAsync(ct)
                : await db.OrganizationMembers.Where(m => m.UserId == user.Id).Select(m => m.OrganizationId).ToListAsync(ct);
            items.AddRange(await DocsAsync(db, orgIds, cursor, take, showEmails, ct));
        }

        if (kinds.Contains(ActivityKinds.SignIns))
        {
            items.AddRange(await SignInsAsync(db, user.IsSystemAdmin, adminOrgIds, cursor, take, ct));
        }

        if (kinds.Contains(ActivityKinds.Errors))
        {
            items.AddRange(await ErrorsAsync(db, cursor, take, ct));
        }

        var page = items.OrderByDescending(i => i.OccurredAt).ThenByDescending(i => i.Id, StringComparer.Ordinal).Take(take).ToList();
        return TypedResults.Ok(new ActivityResponse(page, allowed, page.Count == take ? page[^1].OccurredAt : null));
    }

    private static async Task<List<ActivityItemResponse>> CommentsAsync(
        InklayerDbContext db, Dictionary<Guid, string> projects, string? siteOrigin, DateTime before, int take, bool showEmails, CancellationToken ct)
    {
        var ids = projects.Keys.ToList();
        var query = from r in db.AnnotationRevisions
                    join a in db.Annotations on r.AnnotationId equals a.Id
                    where ids.Contains(a.ProjectId) && r.OccurredAt < before
                    select new { r.Id, r.Action, r.OccurredAt, r.ActorUserId, r.State, a.ProjectId, a.PageUrl, AnnotationId = a.Id };
        if (siteOrigin is not null)
        {
            var prefix = siteOrigin + "/";
            query = query.Where(x => x.PageUrl.StartsWith(prefix));
        }

        var rows = await query.OrderByDescending(x => x.OccurredAt).Take(take).ToListAsync(ct);

        // Replies, which have no revisions of their own.
        var replyQuery = from r in db.AnnotationReplies
                         join a in db.Annotations on r.AnnotationId equals a.Id
                         where ids.Contains(a.ProjectId) && r.DeletedAt == null && a.DeletedAt == null && r.CreatedAt < before
                         select new { r.Id, r.CreatedAt, r.AuthorUserId, r.Body, a.ProjectId, a.PageUrl, AnnotationId = a.Id };
        if (siteOrigin is not null)
        {
            var prefix = siteOrigin + "/";
            replyQuery = replyQuery.Where(x => x.PageUrl.StartsWith(prefix));
        }

        var replies = await replyQuery.OrderByDescending(x => x.CreatedAt).Take(take).ToListAsync(ct);
        var actors = await ActorsAsync(db, rows.Select(r => (Guid?)r.ActorUserId).Concat(replies.Select(r => (Guid?)r.AuthorUserId)), showEmails, ct);
        return [
            .. rows.Select(r => new ActivityItemResponse(
                r.Id.ToString(), ActivityKinds.Comments, r.Action, r.OccurredAt, actors.GetValueOrDefault(r.ActorUserId),
                r.ProjectId, projects[r.ProjectId], r.PageUrl, r.AnnotationId, BodyPreview(r.State))),
            .. replies.Select(r => new ActivityItemResponse(
                r.Id.ToString(), ActivityKinds.Comments, "replied", r.CreatedAt, actors.GetValueOrDefault(r.AuthorUserId),
                r.ProjectId, projects[r.ProjectId], r.PageUrl, r.AnnotationId, r.Body.Length > BodyPreviewLength ? r.Body[..BodyPreviewLength] + "…" : r.Body)),
        ];
    }

    private static async Task<List<ActivityItemResponse>> DocsAsync(
        InklayerDbContext db, List<Guid> organizationIds, DateTime before, int take, bool showEmails, CancellationToken ct)
    {
        var rows = await db.DocRevisions.AsNoTracking()
            .Where(r => organizationIds.Contains(r.OrganizationId) && r.OccurredAt < before)
            .OrderByDescending(r => r.OccurredAt).Take(take)
            .Select(r => new { r.Id, r.Action, r.OccurredAt, r.ActorUserId, r.DocId, r.Title, r.Folder, r.OrganizationId })
            .ToListAsync(ct);
        var actors = await ActorsAsync(db, rows.Select(r => (Guid?)r.ActorUserId), showEmails, ct);
        return rows.Select(r => new ActivityItemResponse(
            r.Id.ToString(), ActivityKinds.Docs, r.Action, r.OccurredAt, actors.GetValueOrDefault(r.ActorUserId),
            null, null, null, null, r.Folder.Length > 0 ? $"{r.Folder}/{r.Title}" : r.Title, r.DocId, r.Title, r.OrganizationId)).ToList();
    }

    private static async Task<List<ActivityItemResponse>> SignInsAsync(
        InklayerDbContext db, bool everyone, List<Guid> adminOrgIds, DateTime before, int take, CancellationToken ct)
    {
        var query = db.AuditEvents.AsNoTracking().Where(e => e.OccurredAt < before);
        if (everyone)
        {
            query = query.Where(e => e.Action == AuditActions.SignInSucceeded || e.Action == AuditActions.SignInDenied);
        }
        else
        {
            // Organisation admins see their members signing in; refused sign-ins have no organisation, so only instance admins see those.
            var members = db.OrganizationMembers.Where(m => adminOrgIds.Contains(m.OrganizationId)).Select(m => (Guid?)m.UserId);
            query = query.Where(e => e.Action == AuditActions.SignInSucceeded && members.Contains(e.ActorUserId));
        }

        var rows = await query.OrderByDescending(e => e.OccurredAt).Take(take).ToListAsync(ct);
        var actors = await ActorsAsync(db, rows.Select(r => r.ActorUserId), showEmails: true, ct);
        return rows.Select(e => new ActivityItemResponse(
            e.Id.ToString(), ActivityKinds.SignIns, e.Action == AuditActions.SignInSucceeded ? "signed_in" : "sign_in_refused", e.OccurredAt,
            e.ActorUserId is { } id ? actors.GetValueOrDefault(id) : null, null, null, null, null, RefusalDetail(e))).ToList();
    }

    private static async Task<List<ActivityItemResponse>> ErrorsAsync(InklayerDbContext db, DateTime before, int take, CancellationToken ct)
    {
        var rows = await db.ErrorEvents.AsNoTracking().Where(e => e.OccurredAt < before).OrderByDescending(e => e.OccurredAt).Take(take).ToListAsync(ct);
        var actors = await ActorsAsync(db, rows.Select(r => r.UserId), showEmails: true, ct);
        return rows.Select(e => new ActivityItemResponse(
            e.Id.ToString(), ActivityKinds.Errors, "error", e.OccurredAt, e.UserId is { } id ? actors.GetValueOrDefault(id) : null,
            null, null, null, null, $"{e.Method} {e.Path} failed ({e.StatusCode}): {e.Message}" + (e.TraceId is null ? "" : $" [trace {e.TraceId}]"))).ToList();
    }

    private static async Task<Dictionary<Guid, ActivityActor>> ActorsAsync(InklayerDbContext db, IEnumerable<Guid?> ids, bool showEmails, CancellationToken ct)
    {
        var distinct = ids.OfType<Guid>().Distinct().ToList();
        return await db.Users.AsNoTracking().Where(u => distinct.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => new ActivityActor(u.Id, u.DisplayName, showEmails ? u.Email : null), ct);
    }

    private static string? BodyPreview(string state)
    {
        using var doc = JsonDocument.Parse(state);
        if (!doc.RootElement.TryGetProperty("body", out var body) || body.GetString() is not { Length: > 0 } text)
        {
            return null;
        }

        return text.Length > BodyPreviewLength ? text[..BodyPreviewLength] + "…" : text;
    }

    private static string? RefusalDetail(AuditEvent e)
    {
        if (e.Action != AuditActions.SignInDenied || e.Data is null)
        {
            return null;
        }

        using var doc = JsonDocument.Parse(e.Data);
        var root = doc.RootElement;
        string? Get(string name) => root.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        return $"{Get("email") ?? "Unknown email"} via {Get("provider") ?? "?"}: {Get("reason") ?? "refused"}";
    }
}
