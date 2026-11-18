using Inklayer.Infrastructure.Storage;

namespace Inklayer.Api.Features.Snapshots;

internal static class SnapshotContentTypes
{
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/bmp",
        "image/x-icon", "image/vnd.microsoft.icon",
        "font/woff", "font/woff2", "font/ttf", "font/otf", "font/collection", "font/sfnt",
        "application/font-woff", "application/font-woff2", "application/x-font-ttf", "application/x-font-otf",
        "application/vnd.ms-fontobject", "application/font-sfnt",
        "text/css",
    };

    /// <summary>Assets are only ever served with types a page can safely use. Anything else becomes <c>application/octet-stream</c>.</summary>
    public static string Normalize(string contentType)
    {
        var type = contentType.Split(';', 2)[0].Trim().ToLowerInvariant();
        return Allowed.Contains(type) ? type : "application/octet-stream";
    }

    /// <summary>Identifies a screenshot by its leading bytes, so a fake "screenshot" can't be served as something else.</summary>
    public static async Task<string?> DetectScreenshotAsync(BlobStore blobs, string hash, CancellationToken ct)
    {
        await using var stream = blobs.OpenRead(hash);
        if (stream is null)
        {
            return null;
        }

        var header = new byte[12];
        var read = await stream.ReadAtLeastAsync(header, header.Length, throwOnEndOfStream: false, ct);
        if (read >= 8 && header.AsSpan(0, 8).SequenceEqual(new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }))
        {
            return "image/png";
        }

        if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
        {
            return "image/jpeg";
        }

        if (read >= 12 && header.AsSpan(0, 4).SequenceEqual("RIFF"u8) && header.AsSpan(8, 4).SequenceEqual("WEBP"u8))
        {
            return "image/webp";
        }

        return null;
    }
}
