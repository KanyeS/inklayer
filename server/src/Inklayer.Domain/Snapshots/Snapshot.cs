namespace Inklayer.Domain.Snapshots;

/// <summary>
/// A frozen copy of a web page as one user saw it. It holds sanitized HTML plus the assets (images, fonts) it references,
/// and optionally a screenshot of the visible area. Snapshots are immutable once created.
/// </summary>
public sealed class Snapshot
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid ProjectId { get; init; }

    /// <summary>Copied from the project so tenant filtering doesn't need a join.</summary>
    public required Guid OrganizationId { get; init; }

    public required string Url { get; init; }

    public required string Title { get; init; }

    public required int ViewportWidth { get; init; }

    public required int ViewportHeight { get; init; }

    public required double DevicePixelRatio { get; init; }

    public int ScrollX { get; init; }

    public int ScrollY { get; init; }

    public string? UserAgent { get; init; }

    /// <summary>SHA-256 of the sanitized HTML document blob.</summary>
    public required string DocumentHash { get; init; }

    /// <summary>SHA-256 of the screenshot blob (PNG or JPEG), if one was captured.</summary>
    public string? ScreenshotHash { get; init; }

    public string? ScreenshotContentType { get; init; }

    /// <summary>Document, screenshot and all assets, in bytes.</summary>
    public long TotalBytes { get; init; }

    public required Guid CapturedByUserId { get; init; }

    public DateTime CapturedAt { get; init; }

    public List<SnapshotAsset> Assets { get; init; } = [];
}

/// <summary>An asset referenced by a snapshot's HTML as <c>a/{hash}</c>.</summary>
public sealed class SnapshotAsset
{
    public required Guid SnapshotId { get; init; }

    public required string Hash { get; init; }

    public required string ContentType { get; init; }

    public long Size { get; init; }
}

/// <summary>
/// Records that an organisation uploaded a blob. Blobs are stored once on disk, but checks for missing blobs
/// only look at the organisation's own records, so they can't reveal what other tenants have uploaded.
/// </summary>
public sealed class OrganizationBlob
{
    public required Guid OrganizationId { get; init; }

    public required string Hash { get; init; }

    public long Size { get; init; }

    public DateTime CreatedAt { get; init; }
}
