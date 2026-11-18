namespace Inklayer.Domain.Annotations;

public enum AnnotationKind
{
    /// <summary>A comment marker at a point, attached to the element under it.</summary>
    Pin,

    /// <summary>A whole element, outlined.</summary>
    Element,

    /// <summary>A range of text.</summary>
    Highlight,

    Rect,

    Arrow,

    /// <summary>Freehand drawing.</summary>
    Ink,
}

public enum AnnotationStatus
{
    Open,
    Resolved,
}

/// <summary>
/// A mark with an optional comment, on either a snapshot or a live page:
/// <list type="bullet">
/// <item>Snapshot annotations have <see cref="SnapshotId"/> set and are drawn on the frozen copy.</item>
/// <item>Live annotations have <see cref="PageUrl"/> set and are re-anchored on the real page each time someone with the extension opens it.</item>
/// </list>
/// Exactly one of the two is set. Both kinds store:
/// <list type="bullet">
/// <item><see cref="Anchor"/>: how to find the element or text again (several independent selectors).</item>
/// <item><see cref="Geometry"/>: the shape relative to that anchor.</item>
/// </list>
/// The server stores both as opaque JSON; only the overlay interprets them. Every change adds an <see cref="AnnotationRevision"/>.
/// </summary>
public sealed class Annotation
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    /// <summary>The snapshot this is drawn on, or null for a live-page annotation.</summary>
    public Guid? SnapshotId { get; init; }

    /// <summary>For live-page annotations: the page's URL, normalised by the project's matching rules (see <c>LivePageUrl</c>).</summary>
    public string? PageUrl { get; init; }

    public required Guid ProjectId { get; init; }

    public required Guid OrganizationId { get; init; }

    public required Guid AuthorUserId { get; init; }

    public required AnnotationKind Kind { get; init; }

    public AnnotationStatus Status { get; set; } = AnnotationStatus.Open;

    public string Body { get; set; } = "";

    /// <summary>CSS hex colour, e.g. <c>#f59e0b</c>.</summary>
    public string Color { get; set; } = "#f59e0b";

    public required string Anchor { get; set; }

    public required string Geometry { get; set; }

    /// <summary>The viewer's layout width when this was drawn; the UI warns when viewing at a different width.</summary>
    public int ViewportWidth { get; set; }

    /// <summary>Starts at 1 and goes up by one on every change. Clients send it back to detect conflicting edits.</summary>
    public int Version { get; set; } = 1;

    public DateTime CreatedAt { get; init; }

    public DateTime UpdatedAt { get; set; }

    public Guid? ResolvedByUserId { get; set; }

    public DateTime? ResolvedAt { get; set; }

    /// <summary>Soft delete: deleted annotations stay in history.</summary>
    public DateTime? DeletedAt { get; set; }
}

public static class AnnotationActions
{
    public const string Created = "created";
    public const string Updated = "updated";
    public const string Resolved = "resolved";
    public const string Reopened = "reopened";
    public const string Deleted = "deleted";
}

/// <summary>Append-only history: the full state of an annotation after each change, and who made it.</summary>
public sealed class AnnotationRevision
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid AnnotationId { get; init; }

    public required int Version { get; init; }

    public required string Action { get; init; }

    public required Guid ActorUserId { get; init; }

    public DateTime OccurredAt { get; init; }

    /// <summary>JSON of the annotation's state after the change.</summary>
    public required string State { get; init; }
}
