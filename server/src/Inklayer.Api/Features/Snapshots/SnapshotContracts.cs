using System.ComponentModel.DataAnnotations;

namespace Inklayer.Api.Features.Snapshots;

public sealed record MissingBlobsRequest([property: Required, MaxLength(10000)] IReadOnlyList<string> Hashes);

public sealed record MissingBlobsResponse(IReadOnlyList<string> Missing);

public sealed record SnapshotAssetRequest(
    [property: Required, StringLength(64, MinimumLength = 64)] string Hash,
    [property: Required, StringLength(128)] string ContentType);

public sealed record CreateSnapshotRequest(
    [property: Required, StringLength(4096)] string Url,
    [property: StringLength(2000)] string? Title,
    [property: Range(1, 20000)] int ViewportWidth,
    [property: Range(1, 20000)] int ViewportHeight,
    [property: Range(0.25, 8)] double DevicePixelRatio,
    int ScrollX,
    int ScrollY,
    [property: StringLength(512)] string? UserAgent,
    [property: Required, StringLength(64, MinimumLength = 64)] string DocumentHash,
    [property: StringLength(64, MinimumLength = 64)] string? ScreenshotHash,
    [property: Required] IReadOnlyList<SnapshotAssetRequest> Assets);

public sealed record UserSummary(Guid Id, string DisplayName);

public sealed record SnapshotSummary(
    Guid Id, Guid ProjectId, string Url, string Title, DateTime CapturedAt, UserSummary CapturedBy,
    int ViewportWidth, int ViewportHeight, bool HasScreenshot, int AssetCount, long TotalBytes);

public sealed record SnapshotResponse(
    Guid Id, Guid ProjectId, Guid OrganizationId, string Url, string Title, DateTime CapturedAt, UserSummary CapturedBy,
    int ViewportWidth, int ViewportHeight, double DevicePixelRatio, int ScrollX, int ScrollY, string? UserAgent,
    int AssetCount, long TotalBytes, Uri? ViewUrl, string? ScreenshotUrl);
