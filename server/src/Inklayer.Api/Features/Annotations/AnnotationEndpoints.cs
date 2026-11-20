using System.Text.Json;
using System.Text.RegularExpressions;
using Inklayer.Api.Access;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Features.Notifications;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Annotations;

/// <summary>
/// Editing annotations; they're created and listed in <c>LiveEndpoints</c>. Who can do what:
/// <list type="bullet">
/// <item>Commenters and above can create annotations, and resolve or reopen any annotation.</item>
/// <item>Authors can edit and delete their own; project Admins can edit and delete anyone's.</item>
/// </list>
/// Every change bumps <c>version</c> and appends a revision. Updates that send a stale version get 409, along with the current state.
/// </summary>
internal static partial class AnnotationEndpoints
{
    private const int MaxAnchorBytes = 16 * 1024;
    private const int MaxGeometryBytes = 512 * 1024;
    private static readonly JsonSerializerOptions StateJson = new(JsonSerializerDefaults.Web) { Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() } };

    public static IEndpointRouteBuilder MapAnnotationEndpoints(this IEndpointRouteBuilder app)
    {
        var annotations = app.MapGroup("/api/annotations").WithTags("Annotations").RequireAuthorization();
        annotations.MapGet("/{annotationId:guid}", GetAsync).Produces<AnnotationDetailResponse>().WithSummary("One comment, with its project, page and the docs that mention it");
        annotations.MapPatch("/{annotationId:guid}", UpdateAsync).Produces<AnnotationResponse>();
        annotations.MapDelete("/{annotationId:guid}", DeleteAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Soft-delete; send ?version= to guard against deleting a changed annotation");
        annotations.MapGet("/{annotationId:guid}/history", HistoryAsync).Produces<List<AnnotationRevisionResponse>>().WithSummary("Every revision, oldest first");
        annotations.MapPost("/{annotationId:guid}/replies", CreateReplyAsync).Produces<ReplyResponse>(StatusCodes.Status201Created).WithSummary("Reply in a comment's thread (Commenters and above)");

        var replies = app.MapGroup("/api/replies").WithTags("Annotations").RequireAuthorization();
        replies.MapPatch("/{replyId:guid}", UpdateReplyAsync).Produces<ReplyResponse>().WithSummary("Edit your reply (project Admins: anyone's)");
        replies.MapDelete("/{replyId:guid}", DeleteReplyAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Delete a reply: ?version=");

        return app;
    }

    /// <summary>Where a new annotation goes: a project, and the page's normalised URL.</summary>
    internal readonly record struct AnnotationTarget(Guid ProjectId, Guid OrganizationId, string PageUrl);

    /// <summary>Validates and saves a new annotation. The caller has already checked <see cref="Permission.Comment"/>.</summary>
    internal static async Task<IResult> CreateCoreAsync(
        AnnotationTarget target, AnnotationKind kind, string? body, string? requestedColor, JsonElement anchorJson, JsonElement geometryJson, int viewportWidth,
        Role role, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, NotificationService notifications, TimeProvider clock, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        var anchor = ValidateJson(anchorJson, "anchor", MaxAnchorBytes, errors);
        var geometry = ValidateJson(geometryJson, "geometry", MaxGeometryBytes, errors);
        var color = requestedColor ?? "#f59e0b";
        if (!ColorPattern().IsMatch(color))
        {
            errors["color"] = ["Must be a hex colour like #f59e0b."];
        }

        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var userId = currentUser.Id!.Value;
        var annotation = new Annotation
        {
            PageUrl = target.PageUrl,
            ProjectId = target.ProjectId,
            OrganizationId = target.OrganizationId,
            AuthorUserId = userId,
            Kind = kind,
            Body = body?.Trim() ?? "",
            Color = color.ToLowerInvariant(),
            Anchor = anchor!,
            Geometry = geometry!,
            ViewportWidth = viewportWidth,
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.Annotations.Add(annotation);
        db.AnnotationRevisions.Add(Revision(annotation, AnnotationActions.Created, userId, now));
        await db.SaveChangesAsync(ct);
        await indexer.IndexCommentAsync(annotation, ct);
        await db.SaveChangesAsync(ct);
        await notifications.CommentCreatedAsync(annotation, ct);

        var authors = await AuthorsAsync(db, [userId], ct);
        return TypedResults.Created($"/api/annotations/{annotation.Id}", (await EnrichAsync(db, [ToResponse(annotation, authors, role, userId)], _ => role, userId, ct))[0]);
    }

    internal static async Task<IResult> UpdateAsync(
        Guid annotationId, UpdateAnnotationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer,
        NotificationService notifications, Issues.IssueService issues, TimeProvider clock, CancellationToken ct)
    {
        var annotation = await db.Annotations.SingleOrDefaultAsync(a => a.Id == annotationId && a.DeletedAt == null, ct);
        if (annotation is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(annotation.ProjectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var userId = currentUser.Id!.Value;
        var editsContent = request.Body is not null || request.Color is not null || request.Anchor is not null || request.Geometry is not null || request.ViewportWidth is not null;
        if (editsContent && !CanEdit(annotation, check.Role, userId))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the author or a project Admin can edit this annotation.");
        }

        var authors = await AuthorsAsync(db, [annotation.AuthorUserId, userId], ct);
        if (request.Version != annotation.Version)
        {
            return Conflict(annotation, authors, check.Role, userId);
        }

        var errors = new Dictionary<string, string[]>();
        var anchor = request.Anchor is { } a ? ValidateJson(a, "anchor", MaxAnchorBytes, errors) : null;
        var geometry = request.Geometry is { } g ? ValidateJson(g, "geometry", MaxGeometryBytes, errors) : null;
        if (request.Color is not null && !ColorPattern().IsMatch(request.Color))
        {
            errors["color"] = ["Must be a hex colour like #f59e0b."];
        }

        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var action = AnnotationActions.Updated;
        var previousStatus = annotation.Status;
        if (request.Status is { } status && status != annotation.Status)
        {
            annotation.Status = status;
            annotation.ResolvedAt = status == AnnotationStatus.Resolved ? now : null;
            annotation.ResolvedByUserId = status == AnnotationStatus.Resolved ? userId : null;
            action = editsContent ? AnnotationActions.Updated : status == AnnotationStatus.Resolved ? AnnotationActions.Resolved : AnnotationActions.Reopened;
        }

        var bodyChanged = request.Body is not null && request.Body.Trim() != annotation.Body;
        var oldBody = annotation.Body;
        var resolvedNow = previousStatus != AnnotationStatus.Resolved && annotation.Status == AnnotationStatus.Resolved;
        annotation.Body = request.Body?.Trim() ?? annotation.Body;
        annotation.Color = request.Color?.ToLowerInvariant() ?? annotation.Color;
        annotation.Anchor = anchor ?? annotation.Anchor;
        annotation.Geometry = geometry ?? annotation.Geometry;
        annotation.ViewportWidth = request.ViewportWidth ?? annotation.ViewportWidth;
        annotation.Version++;
        annotation.UpdatedAt = now;
        db.AnnotationRevisions.Add(Revision(annotation, action, userId, now));

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            // Someone else saved between our read and write.
            db.ChangeTracker.Clear();
            var current = await db.Annotations.AsNoTracking().SingleAsync(x => x.Id == annotationId, ct);
            return Conflict(current, authors, check.Role, userId);
        }

        if (bodyChanged)
        {
            await indexer.IndexCommentAsync(annotation, ct);
            await db.SaveChangesAsync(ct);
            await notifications.CommentEditedAsync(annotation, oldBody, userId, ct);
        }

        if (resolvedNow)
        {
            await notifications.ResolvedAsync(annotation, userId, ct);
            await issues.CommentResolvedAsync(annotation, ct);
        }

        return TypedResults.Ok((await EnrichAsync(db, [ToResponse(annotation, authors, check.Role, userId)], _ => check.Role, userId, ct))[0]);
    }

    private static async Task<IResult> DeleteAsync(
        Guid annotationId, int? version, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var annotation = await db.Annotations.SingleOrDefaultAsync(a => a.Id == annotationId && a.DeletedAt == null, ct);
        if (annotation is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(annotation.ProjectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var userId = currentUser.Id!.Value;
        if (!CanEdit(annotation, check.Role, userId))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the author or a project Admin can delete this annotation.");
        }

        if (version is { } expected && expected != annotation.Version)
        {
            return Conflict(annotation, await AuthorsAsync(db, [annotation.AuthorUserId], ct), check.Role, userId);
        }

        var now = clock.GetUtcNow().UtcDateTime;
        annotation.DeletedAt = now;
        annotation.Version++;
        annotation.UpdatedAt = now;
        db.AnnotationRevisions.Add(Revision(annotation, AnnotationActions.Deleted, userId, now));
        await db.SaveChangesAsync(ct);
        await indexer.IndexCommentAsync(annotation, ct); // a deleted comment links nothing
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    internal static async Task<IResult> GetAsync(Guid annotationId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var annotation = await db.Annotations.AsNoTracking().SingleOrDefaultAsync(a => a.Id == annotationId && a.DeletedAt == null, ct);
        if (annotation is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(annotation.ProjectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var projectName = await db.Projects.Where(p => p.Id == annotation.ProjectId).Select(p => p.Name).SingleAsync(ct);
        var authors = await AuthorsAsync(db, [annotation.AuthorUserId], ct);
        var (links, mentions) = await DocLinksAsync(db, new() { [annotation.Id] = annotation.Body }, ct);
        var (contexts, screenshots) = await ContextEndpoints.ForAsync(db, [annotation.Id], ct);
        return TypedResults.Ok(new AnnotationDetailResponse(
            annotation.Id, annotation.OrganizationId, annotation.ProjectId, projectName, annotation.PageUrl, annotation.Body, annotation.Status,
            authors.GetValueOrDefault(annotation.AuthorUserId) ?? new AuthorSummary(annotation.AuthorUserId, "", null), annotation.CreatedAt,
            links.GetValueOrDefault(annotation.Id, []), mentions.GetValueOrDefault(annotation.Id, []),
            (await RepliesAsync(db, [annotation.Id], _ => check.Role, currentUser.Id!.Value, ct)).GetValueOrDefault(annotation.Id, []),
            check.Role.Grants(Permission.Comment), contexts.GetValueOrDefault(annotation.Id), screenshots.Contains(annotation.Id),
            await MentionedPeople.ForAsync(db, [annotation.Body, .. await db.AnnotationReplies.Where(r => r.AnnotationId == annotation.Id && r.DeletedAt == null).Select(r => r.Body).ToListAsync(ct)], ct),
            (await Issues.IssueService.ForAsync(db, [annotation.Id], ct)).GetValueOrDefault(annotation.Id, []),
            (await Issues.IssueService.CommentsForAsync(db, [annotation.Id], ct)).GetValueOrDefault(annotation.Id, [])));
    }

    /* ---------------------------------------------------------------- replies */

    internal static async Task<IResult> CreateReplyAsync(
        Guid annotationId, CreateReplyRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, NotificationService notifications,
        Issues.IssueService issues, TimeProvider clock, CancellationToken ct)
    {
        var annotation = await db.Annotations.SingleOrDefaultAsync(a => a.Id == annotationId && a.DeletedAt == null, ct);
        if (annotation is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(annotation.ProjectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (await db.Projects.AnyAsync(p => p.Id == annotation.ProjectId && p.IsArchived, ct))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This project is archived.");
        }

        if (request.Body?.Trim() is not { Length: > 0 } body)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["body"] = ["Write something to reply."] });
        }

        var userId = currentUser.Id!.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        var reply = new AnnotationReply { AnnotationId = annotation.Id, AuthorUserId = userId, Body = body, CreatedAt = now, UpdatedAt = now };
        db.AnnotationReplies.Add(reply);
        await db.SaveChangesAsync(ct);
        await indexer.IndexCommentAsync(annotation, ct);
        await db.SaveChangesAsync(ct);
        await notifications.ReplyAsync(annotation, reply, ct);
        await issues.ReplyAddedAsync(annotation, reply, ct);

        var authors = await AuthorsAsync(db, [userId], ct);
        return TypedResults.Created($"/api/replies/{reply.Id}", ToReply(reply, authors, check.Role, userId));
    }

    internal static async Task<IResult> UpdateReplyAsync(
        Guid replyId, UpdateReplyRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, NotificationService notifications, TimeProvider clock, CancellationToken ct)
    {
        var (reply, annotation, role, denied) = await ReplyForChangeAsync(replyId, access, currentUser, db, ct);
        if (denied is not null || reply is null || annotation is null)
        {
            return denied ?? TypedResults.NotFound();
        }

        if (request.Version != reply.Version)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This reply was changed by someone else. Reload to see it.");
        }

        if (request.Body?.Trim() is not { Length: > 0 } body)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["body"] = ["A reply can't be empty. Delete it instead."] });
        }

        var userId = currentUser.Id!.Value;
        var oldBody = reply.Body;
        reply.Body = body;
        reply.Version++;
        reply.UpdatedAt = clock.GetUtcNow().UtcDateTime;
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This reply was changed by someone else. Reload to see it.");
        }

        await indexer.IndexCommentAsync(annotation, ct);
        await db.SaveChangesAsync(ct);
        await notifications.ReplyEditedAsync(annotation, reply, oldBody, userId, ct);
        return TypedResults.Ok(ToReply(reply, await AuthorsAsync(db, [reply.AuthorUserId], ct), role, userId));
    }

    internal static async Task<IResult> DeleteReplyAsync(
        Guid replyId, int? version, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var (reply, annotation, _, denied) = await ReplyForChangeAsync(replyId, access, currentUser, db, ct);
        if (denied is not null || reply is null || annotation is null)
        {
            return denied ?? TypedResults.NotFound();
        }

        if (version is { } expected && expected != reply.Version)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This reply was changed by someone else. Reload to see it.");
        }

        reply.DeletedAt = clock.GetUtcNow().UtcDateTime;
        reply.Version++;
        await db.SaveChangesAsync(ct);
        await indexer.IndexCommentAsync(annotation, ct);
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    /// <summary>The reply and its comment, if the caller may change the reply: its author (Commenter and above) or a project Admin.</summary>
    private static async Task<(AnnotationReply? Reply, Annotation? Annotation, Role Role, IResult? Denied)> ReplyForChangeAsync(
        Guid replyId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var reply = await db.AnnotationReplies.SingleOrDefaultAsync(r => r.Id == replyId && r.DeletedAt == null, ct);
        var annotation = reply is null ? null : await db.Annotations.SingleOrDefaultAsync(a => a.Id == reply.AnnotationId && a.DeletedAt == null, ct);
        if (reply is null || annotation is null)
        {
            return (null, null, default, TypedResults.NotFound());
        }

        var check = await access.CheckProjectAsync(annotation.ProjectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return (null, null, default, check.Denied);
        }

        return CanChangeReply(reply, check.Role, currentUser.Id!.Value)
            ? (reply, annotation, check.Role, null)
            : (null, null, default, TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only its author or a project Admin can change this reply."));
    }

    private static bool CanChangeReply(AnnotationReply reply, Role role, Guid userId) =>
        (reply.AuthorUserId == userId && role.Grants(Permission.Comment)) || role.Grants(Permission.ManageProjects);

    private static ReplyResponse ToReply(AnnotationReply r, Dictionary<Guid, AuthorSummary> authors, Role role, Guid userId) => new(
        r.Id, r.Body, authors.GetValueOrDefault(r.AuthorUserId) ?? new AuthorSummary(r.AuthorUserId, "", null), r.CreatedAt, r.UpdatedAt, r.Version,
        CanChangeReply(r, role, userId), CanChangeReply(r, role, userId));

    /// <summary>The replies of each comment, oldest first. <paramref name="roleOf"/> gives the caller's role in a comment's project.</summary>
    private static async Task<Dictionary<Guid, List<ReplyResponse>>> RepliesAsync(
        InklayerDbContext db, List<Guid> annotationIds, Func<Guid, Role> roleOf, Guid userId, CancellationToken ct)
    {
        var rows = await (from r in db.AnnotationReplies.AsNoTracking()
                          where annotationIds.Contains(r.AnnotationId) && r.DeletedAt == null
                          join a in db.Annotations on r.AnnotationId equals a.Id
                          orderby r.CreatedAt
                          select new { Reply = r, a.ProjectId }).ToListAsync(ct);
        var authors = await AuthorsAsync(db, rows.Select(x => x.Reply.AuthorUserId), ct);
        return rows.GroupBy(x => x.Reply.AnnotationId)
            .ToDictionary(g => g.Key, g => g.Select(x => ToReply(x.Reply, authors, roleOf(x.ProjectId), userId)).ToList());
    }

    /// <summary>Adds each comment's replies, doc links and the docs that mention it. <paramref name="roleOf"/> gives the caller's role in a project.</summary>
    internal static async Task<List<AnnotationResponse>> EnrichAsync(
        InklayerDbContext db, IReadOnlyList<AnnotationResponse> responses, Func<Guid, Role> roleOf, Guid userId, CancellationToken ct)
    {
        var replies = await RepliesAsync(db, [.. responses.Select(r => r.Id)], roleOf, userId, ct);

        // Each author's role in the comment's organisation, for "Real Name · Role" on hover.
        var orgIds = responses.Select(r => r.OrganizationId).Distinct().ToList();
        var people = responses.Select(r => r.Author.Id).Concat(replies.Values.SelectMany(l => l.Select(x => x.Author.Id))).Distinct().ToList();
        var memberRoles = (await db.OrganizationMembers.AsNoTracking()
                .Where(m => orgIds.Contains(m.OrganizationId) && people.Contains(m.UserId))
                .Select(m => new { m.OrganizationId, m.UserId, m.Role }).ToListAsync(ct))
            .ToDictionary(m => (m.OrganizationId, m.UserId), m => m.Role);
        AuthorSummary WithRole(AuthorSummary a, Guid orgId) => a with { Role = memberRoles.TryGetValue((orgId, a.Id), out var r) ? r : null };
        replies = replies.ToDictionary(kv => kv.Key, kv =>
        {
            var orgId = responses.First(r => r.Id == kv.Key).OrganizationId;
            return kv.Value.Select(x => x with { Author = WithRole(x.Author, orgId) }).ToList();
        });
        var (contexts, screenshots) = await ContextEndpoints.ForAsync(db, [.. responses.Select(r => r.Id)], ct);
        var issues = await Issues.IssueService.ForAsync(db, [.. responses.Select(r => r.Id)], ct);
        var issueComments = await Issues.IssueService.CommentsForAsync(db, [.. responses.Select(r => r.Id)], ct);
        var mentioned = await MentionedPeople.ForAsync(db, responses.Select(r => r.Body).Concat(replies.Values.SelectMany(l => l.Select(x => x.Body))), ct);
        responses = [.. responses.Select(r => r with
        {
            Author = WithRole(r.Author, r.OrganizationId), Context = contexts.GetValueOrDefault(r.Id), HasScreenshot = screenshots.Contains(r.Id),
            Issues = issues.GetValueOrDefault(r.Id, []),
            IssueComments = issueComments.GetValueOrDefault(r.Id, []),
            People = [.. mentioned.Where(p => Domain.Notifications.Mentions.Extract(r.Body).Contains(p.Id)
                || replies.GetValueOrDefault(r.Id, []).Any(x => Domain.Notifications.Mentions.Extract(x.Body).Contains(p.Id)))],
        })];
        // Links are matched against the comment and its replies together.
        var texts = responses.ToDictionary(r => r.Id, r => string.Join('\n', [r.Body, .. replies.GetValueOrDefault(r.Id, []).Select(x => x.Body)]));
        var (links, mentions) = await DocLinksAsync(db, texts, ct);
        return [.. responses.Select(r => r with
        {
            DocLinks = links.GetValueOrDefault(r.Id, []), MentionedIn = mentions.GetValueOrDefault(r.Id, []), Replies = replies.GetValueOrDefault(r.Id, []),
        })];
    }

    private static async Task<(Dictionary<Guid, List<AnnotationDocLink>> Links, Dictionary<Guid, List<AnnotationMention>> Mentions)> DocLinksAsync(
        InklayerDbContext db, Dictionary<Guid, string> bodies, CancellationToken ct)
    {
        var ids = bodies.Keys.ToList();
        var outgoing = await (from l in db.DocLinks.AsNoTracking()
                              where l.SourceAnnotationId != null && ids.Contains(l.SourceAnnotationId.Value)
                              join d in db.Docs.Where(d => d.DeletedAt == null) on l.TargetDocId equals d.Id into target
                              from d in target.DefaultIfEmpty()
                              select new { AnnotationId = l.SourceAnnotationId!.Value, l.Text, DocId = d == null ? (Guid?)null : d.Id, Title = d == null ? null : d.Title })
            .ToListAsync(ct);
        var incoming = await (from l in db.DocLinks.AsNoTracking()
                              where l.TargetAnnotationId != null && ids.Contains(l.TargetAnnotationId.Value) && l.SourceDocId != null
                              join d in db.Docs.Where(d => d.DeletedAt == null) on l.SourceDocId equals d.Id
                              select new { AnnotationId = l.TargetAnnotationId!.Value, DocId = d.Id, d.Title })
            .ToListAsync(ct);
        return (
            // In the order they appear in the comment.
            outgoing.GroupBy(l => l.AnnotationId).ToDictionary(g => g.Key, g => g
                .OrderBy(l => bodies[g.Key].IndexOf(l.Text, StringComparison.OrdinalIgnoreCase) is var at and >= 0 ? at : int.MaxValue)
                .Select(l => new AnnotationDocLink(l.Text, l.DocId, l.Title)).ToList()),
            incoming.GroupBy(l => l.AnnotationId).ToDictionary(g => g.Key, g => g.DistinctBy(l => l.DocId).OrderBy(l => l.Title).Select(l => new AnnotationMention(l.DocId, l.Title)).ToList()));
    }

    private static async Task<IResult> HistoryAsync(Guid annotationId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var projectId = await db.Annotations.Where(a => a.Id == annotationId).Select(a => (Guid?)a.ProjectId).SingleOrDefaultAsync(ct);
        if (projectId is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(projectId.Value, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var revisions = await db.AnnotationRevisions.AsNoTracking().Where(r => r.AnnotationId == annotationId).OrderBy(r => r.Version).ToListAsync(ct);
        var actors = await AuthorsAsync(db, revisions.Select(r => r.ActorUserId), ct);
        return TypedResults.Ok(revisions.Select(r => new AnnotationRevisionResponse(
            r.Version, r.Action, actors.GetValueOrDefault(r.ActorUserId) ?? new AuthorSummary(r.ActorUserId, "", null), r.OccurredAt, Parse(r.State))).ToList());
    }

    private static bool CanEdit(Annotation annotation, Role role, Guid userId) =>
        (annotation.AuthorUserId == userId && role.Grants(Permission.Comment)) || role.Grants(Permission.ManageProjects);

    private static IResult Conflict(Annotation current, Dictionary<Guid, AuthorSummary> authors, Role role, Guid userId) =>
        TypedResults.Problem(
            statusCode: StatusCodes.Status409Conflict,
            title: "This annotation was changed by someone else.",
            extensions: new Dictionary<string, object?> { ["current"] = current.DeletedAt is null ? ToResponse(current, authors, role, userId) : null });

    private static string? ValidateJson(JsonElement value, string field, int maxBytes, Dictionary<string, string[]> errors)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            errors[field] = ["Must be a JSON object."];
            return null;
        }

        var raw = value.GetRawText();
        if (raw.Length > maxBytes)
        {
            errors[field] = [$"Must be at most {maxBytes / 1024} KB."];
            return null;
        }

        return raw;
    }

    internal static AnnotationRevision Revision(Annotation a, string action, Guid actorUserId, DateTime now) => new()
    {
        AnnotationId = a.Id,
        Version = a.Version,
        Action = action,
        ActorUserId = actorUserId,
        OccurredAt = now,
        State = JsonSerializer.Serialize(new
        {
            a.Kind, a.Status, a.Body, a.Color, Anchor = Parse(a.Anchor), Geometry = Parse(a.Geometry), a.ViewportWidth, a.ResolvedAt, a.ResolvedByUserId, a.DeletedAt,
        }, StateJson),
    };

    internal static async Task<Dictionary<Guid, AuthorSummary>> AuthorsAsync(InklayerDbContext db, IEnumerable<Guid> ids, CancellationToken ct)
    {
        var distinct = ids.Distinct().ToList();
        return await db.Users.AsNoTracking().Where(u => distinct.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => new AuthorSummary(u.Id, u.PreferredName ?? u.DisplayName, u.AvatarUrl, u.DisplayName), ct);
    }

    internal static AnnotationResponse ToResponse(Annotation a, Dictionary<Guid, AuthorSummary> authors, Role role, Guid userId) => new(
        a.Id, a.ProjectId, a.PageUrl, a.Kind, a.Status, a.Body, a.Color, Parse(a.Anchor), Parse(a.Geometry), a.ViewportWidth, a.Version,
        authors.GetValueOrDefault(a.AuthorUserId) ?? new AuthorSummary(a.AuthorUserId, "", null),
        a.CreatedAt, a.UpdatedAt, a.ResolvedAt, a.ResolvedByUserId,
        CanEdit(a, role, userId), CanEdit(a, role, userId), a.OrganizationId);

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();
}
