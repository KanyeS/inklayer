using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using Inklayer.Domain.Annotations;

namespace Inklayer.Api.Features.Annotations;

public sealed record CreateAnnotationRequest(
    [property: Required] AnnotationKind? Kind,
    [property: StringLength(10_000)] string? Body,
    [property: StringLength(7)] string? Color,
    JsonElement Anchor,
    JsonElement Geometry,
    [property: Range(0, 20000)] int ViewportWidth);

/// <summary>Only the fields that are present change. <see cref="Version"/> must match the annotation's current version.</summary>
public sealed record UpdateAnnotationRequest(
    [property: Range(1, int.MaxValue)] int Version,
    [property: StringLength(10_000)] string? Body,
    [property: StringLength(7)] string? Color,
    AnnotationStatus? Status,
    JsonElement? Anchor,
    JsonElement? Geometry,
    [property: Range(0, 20000)] int? ViewportWidth);

public sealed record AuthorSummary(Guid Id, string DisplayName, string? AvatarUrl);

public sealed record AnnotationResponse(
    Guid Id, Guid SnapshotId, AnnotationKind Kind, AnnotationStatus Status, string Body, string Color,
    JsonElement Anchor, JsonElement Geometry, int ViewportWidth, int Version,
    AuthorSummary Author, DateTime CreatedAt, DateTime UpdatedAt, DateTime? ResolvedAt, Guid? ResolvedByUserId,
    bool CanEdit, bool CanDelete);

public sealed record AnnotationRevisionResponse(int Version, string Action, AuthorSummary Actor, DateTime OccurredAt, JsonElement State);
