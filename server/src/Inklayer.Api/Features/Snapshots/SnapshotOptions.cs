namespace Inklayer.Api.Features.Snapshots;

public sealed class SnapshotOptions
{
    public const string SectionName = "Inklayer:Snapshots";

    /// <summary>
    /// The separate origin that serves captured pages, e.g. <c>https://snapshots.example.com</c>. It must differ from the app's
    /// origin, so captured HTML can never reach the app's cookies or API. If it's empty, snapshots can be captured but not viewed.
    /// </summary>
    public string Origin { get; set; } = "";

    /// <summary>The app's own origin, e.g. <c>https://inklayer.example.com</c>. Only this origin may embed snapshots in a frame.</summary>
    public string AppOrigin { get; set; } = "";

    public int ViewLinkLifetimeMinutes { get; set; } = 120;

    public long MaxBlobBytes { get; set; } = 25 * 1024 * 1024;

    public long MaxDocumentBytes { get; set; } = 15 * 1024 * 1024;

    public int MaxAssetsPerSnapshot { get; set; } = 5000;

    public Uri? OriginUri => Uri.TryCreate(Origin, UriKind.Absolute, out var uri) ? uri : null;
}
