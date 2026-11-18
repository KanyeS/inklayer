using System.Text.Json;
using System.Text.RegularExpressions;
using Inklayer.Api.Access;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Annotations;

/// <summary>
/// Annotations on snapshots; live-page annotations are created and listed in <c>LiveEndpoints</c>, and edited here. Who can do what:
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
        var bySnapshot = app.MapGroup("/api/snapshots/{snapshotId:guid}/annotations").WithTags("Annotations").RequireAuthorization();
        bySnapshot.MapGet("/", ListAsync);
        bySnapshot.MapPost("/", CreateAsync);

        var annotations = app.MapGroup("/api/annotations").WithTags("Annotations").RequireAuthorization();
        annotations.MapPatch("/{annotationId:guid}", UpdateAsync);
        annotations.MapDelete("/{annotationId:guid}", DeleteAsync).WithSummary("Soft-delete; send ?version= to guard against deleting a changed annotation");
        annotations.MapGet("/{annotationId:guid}/history", HistoryAsync).WithSummary("Every revision, oldest first");

        return app;
    }

    private static async Task<IResult> ListAsync(Guid snapshotId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var projectId = await db.Snapshots.Where(s => s.Id == snapshotId).Select(s => (Guid?)s.ProjectId).SingleOrDefaultAsync(ct);
        if (projectId is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(projectId.Value, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var annotations = await db.Annotations.AsNoTracking()
            .Where(a => a.SnapshotId == snapshotId && a.DeletedAt == null)
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(ct);
        var authors = await AuthorsAsync(db, annotations.Select(a => a.AuthorUserId), ct);
        return TypedResults.Ok(annotations.Select(a => ToResponse(a, authors, check.Role, currentUser.Id!.Value)).ToList());
    }

    private static async Task<IResult> CreateAsync(Guid snapshotId, CreateAnnotationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var snapshot = await db.Snapshots.Where(s => s.Id == snapshotId).Select(s => new { s.ProjectId, s.OrganizationId }).SingleOrDefaultAsync(ct);
        if (snapshot is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(snapshot.ProjectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var target = new AnnotationTarget(snapshot.ProjectId, snapshot.OrganizationId, snapshotId, PageUrl: null);
        return await CreateCoreAsync(target, request.Kind!.Value, request.Body, request.Color, request.Anchor, request.Geometry, request.ViewportWidth, check.Role, currentUser, db, clock, ct);
    }

    /// <summary>Where a new annotation goes: a snapshot, or a live page (its normalised URL).</summary>
    internal readonly record struct AnnotationTarget(Guid ProjectId, Guid OrganizationId, Guid? SnapshotId, string? PageUrl);

    /// <summary>Validates and saves a new annotation. The caller has already checked <see cref="Permission.Comment"/>.</summary>
    internal static async Task<IResult> CreateCoreAsync(
        AnnotationTarget target, AnnotationKind kind, string? body, string? requestedColor, JsonElement anchorJson, JsonElement geometryJson, int viewportWidth,
        Role role, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
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
            SnapshotId = target.SnapshotId,
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

        var authors = await AuthorsAsync(db, [userId], ct);
        return TypedResults.Created($"/api/annotations/{annotation.Id}", ToResponse(annotation, authors, role, userId));
    }

    private static async Task<IResult> UpdateAsync(Guid annotationId, UpdateAnnotationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
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
        if (request.Status is { } status && status != annotation.Status)
        {
            annotation.Status = status;
            annotation.ResolvedAt = status == AnnotationStatus.Resolved ? now : null;
            annotation.ResolvedByUserId = status == AnnotationStatus.Resolved ? userId : null;
            action = editsContent ? AnnotationActions.Updated : status == AnnotationStatus.Resolved ? AnnotationActions.Resolved : AnnotationActions.Reopened;
        }

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

        return TypedResults.Ok(ToResponse(annotation, authors, check.Role, userId));
    }

    private static async Task<IResult> DeleteAsync(Guid annotationId, int? version, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
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
        return TypedResults.NoContent();
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

    private static AnnotationRevision Revision(Annotation a, string action, Guid actorUserId, DateTime now) => new()
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
            .ToDictionaryAsync(u => u.Id, u => new AuthorSummary(u.Id, u.DisplayName, u.AvatarUrl), ct);
    }

    internal static AnnotationResponse ToResponse(Annotation a, Dictionary<Guid, AuthorSummary> authors, Role role, Guid userId) => new(
        a.Id, a.SnapshotId, a.PageUrl, a.Kind, a.Status, a.Body, a.Color, Parse(a.Anchor), Parse(a.Geometry), a.ViewportWidth, a.Version,
        authors.GetValueOrDefault(a.AuthorUserId) ?? new AuthorSummary(a.AuthorUserId, "", null),
        a.CreatedAt, a.UpdatedAt, a.ResolvedAt, a.ResolvedByUserId,
        CanEdit(a, role, userId), CanEdit(a, role, userId));

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex ColorPattern();
}
