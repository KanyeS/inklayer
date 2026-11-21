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
/// A mark with an optional comment on a real web page (<see cref="PageUrl"/>). The browser extension re-anchors it to the
/// page each time someone opens the page. It stores:
/// <list type="bullet">
/// <item><see cref="Anchor"/>: how to find the element or text again (several independent selectors).</item>
/// <item><see cref="Geometry"/>: the shape relative to that anchor.</item>
/// </list>
/// The server stores both as opaque JSON; only the overlay interprets them. Every change adds an <see cref="AnnotationRevision"/>.
/// </summary>
public sealed class Annotation
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    /// <summary>The page's URL, normalised by the project's matching rules (see <c>LivePageUrl</c>).</summary>
    public required string PageUrl { get; init; }

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

/// <summary>A reply in a comment's thread. Soft-deleted like annotations; the thread keeps its order by <see cref="CreatedAt"/>.</summary>
public sealed class AnnotationReply
{
    public const int MaxBodyLength = 10_000;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid AnnotationId { get; init; }

    public required Guid AuthorUserId { get; init; }

    public required string Body { get; set; }

    /// <summary>Starts at 1; edits and deletes send it back to detect conflicting changes.</summary>
    public int Version { get; set; } = 1;

    public DateTime CreatedAt { get; init; }

    public DateTime UpdatedAt { get; set; }

    public DateTime? DeletedAt { get; set; }
}

/// <summary>
/// What the page looked like when a comment was made, captured by the extension (if the commenter left it on): browser,
/// viewport, the element, and recent console errors and failed requests. One per comment; only its author can add it.
/// </summary>
public sealed class AnnotationContext
{
    public const int MaxHtmlLength = 8 * 1024;
    public const int MaxLogLength = 16 * 1024;

    public required Guid AnnotationId { get; init; }

    public string Browser { get; init; } = "";

    public string Os { get; init; } = "";

    public string UserAgent { get; init; } = "";

    public int ViewportWidth { get; init; }

    public int ViewportHeight { get; init; }

    public double DevicePixelRatio { get; init; }

    /// <summary>The tab's zoom (1 = 100%), if the extension could read it. Null for comments from before it was recorded.</summary>
    public double? Zoom { get; init; }

    /// <summary>The element's CSS selector path.</summary>
    public string Selector { get; init; } = "";

    /// <summary>The element's HTML, with form values removed, trimmed to <see cref="MaxHtmlLength"/>.</summary>
    public string ElementHtml { get; init; } = "";

    /// <summary>JSON array of recent console errors and warnings: <c>{level, message, at}</c>.</summary>
    public string Console { get; init; } = "[]";

    /// <summary>JSON array of recent failed requests: <c>{method, url, status, ms, at}</c> (URLs without query strings).</summary>
    public string Network { get; init; } = "[]";

    public DateTime CapturedAt { get; init; }
}

/// <summary>A screenshot of the area around a comment, taken when it was made. Stored in the database, so backups include it.</summary>
public sealed class AnnotationScreenshot
{
    public const int MaxBytes = 600 * 1024;

    public required Guid AnnotationId { get; init; }

    public required string ContentType { get; set; }

    public required byte[] Bytes { get; set; }

    public int Width { get; set; }

    public int Height { get; set; }

    public DateTime CreatedAt { get; set; }

    /// <summary>
    /// A long random token for the screenshot's public address (<c>/media/&lt;token&gt;.png</c>), made when it's first put in
    /// an issue, so trackers can show it. Null until then.
    /// </summary>
    public string? PublicToken { get; set; }
}

/// <summary>What kind of file an <see cref="AnnotationMedia"/> is.</summary>
public static class MediaKinds
{
    /// <summary>A screenshot of the whole page, top to bottom.</summary>
    public const string FullPage = "fullpage";

    /// <summary>A recording of the tab.</summary>
    public const string Video = "video";
}

/// <summary>
/// A large file captured with a comment (a full-page screenshot, a video), kept in the media store (S3, or a folder) rather
/// than the database. One of each kind per comment.
/// </summary>
public sealed class AnnotationMedia
{
    public const long MaxImageBytes = 15 * 1024 * 1024;

    /// <summary>A minute's recording, with room to spare.</summary>
    public const long MaxVideoBytes = 40 * 1024 * 1024;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid AnnotationId { get; init; }

    /// <summary><see cref="MediaKinds"/>.</summary>
    public required string Kind { get; init; }

    public required string ContentType { get; set; }

    public long Size { get; set; }

    /// <summary>Where it is in the media store.</summary>
    public required string StorageKey { get; set; }

    public int Width { get; set; }

    public int Height { get; set; }

    public DateTime CreatedAt { get; set; }

    /// <summary>A long random token for its public address (<c>/media/&lt;token&gt;.&lt;ext&gt;</c>), made when it first goes into an issue.</summary>
    public string? PublicToken { get; set; }
}
