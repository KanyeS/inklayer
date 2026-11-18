using Inklayer.Infrastructure.Persistence;
using Inklayer.Infrastructure.Storage;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Snapshots;

/// <summary>
/// Serves captured pages on the separate snapshot origin. The rules:
/// <list type="bullet">
/// <item>Routes answer only when the request's Host is the snapshot origin. The app host never serves captured HTML, and the snapshot host serves nothing else.</item>
/// <item>Each URL carries a signed token that expires (see <see cref="SnapshotLinks"/>), so access control still applies even though no cookies reach this origin.</item>
/// <item>Every response sends a CSP that forbids script, plugins, forms and every load from outside the origin, and sandboxes the document.</item>
/// </list>
/// </summary>
internal static class SnapshotOriginEndpoints
{
    public const string OverlayPath = "/_inklayer/overlay.js";

    /// <summary>
    /// The policy for captured pages. The page's own script is never allowed. Only Inklayer's overlay script runs, admitted by a
    /// per-response nonce. The document is sandboxed with scripts but WITHOUT allow-same-origin, so it gets an opaque origin:
    /// no cookies, no storage, and no same-origin access to anything.
    /// </summary>
    private static string DocumentPolicy(string nonce, string frameAncestors) =>
        "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data:; " +
        $"script-src 'nonce-{nonce}'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; " +
        $"sandbox allow-scripts{frameAncestors}";

    /// <summary>Assets and the overlay script never run as documents.</summary>
    private const string AssetPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

    public static WebApplication UseSnapshotOrigin(this WebApplication app)
    {
        var options = app.Services.GetRequiredService<IOptions<SnapshotOptions>>().Value;
        var origin = options.OriginUri;
        if (origin is null)
        {
            return app;
        }

        // On the snapshot host, refuse everything except /s/ routes and the overlay script. Health checks stay available so a proxy can probe either hostname.
        app.Use((context, next) =>
        {
            if (IsSnapshotHost(context, origin)
                && !context.Request.Path.StartsWithSegments("/s", StringComparison.Ordinal)
                && !context.Request.Path.StartsWithSegments("/health", StringComparison.Ordinal)
                && context.Request.Path != OverlayPath)
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            }

            return next(context);
        });

        var frameAncestors = Uri.TryCreate(options.AppOrigin, UriKind.Absolute, out var appOrigin)
            ? $"; frame-ancestors {appOrigin.GetLeftPart(UriPartial.Authority)}"
            : "";

        var group = app.MapGroup("/s/{snapshotId:guid}/{token}").RequireHost(origin.Authority).ExcludeFromDescription()
            .AddEndpointFilter(async (context, next) =>
            {
                var headers = context.HttpContext.Response.Headers;
                headers.XContentTypeOptions = "nosniff";
                headers["Referrer-Policy"] = "no-referrer";
                headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
                return await next(context);
            });

        group.MapGet("/", (Guid snapshotId, string token, HttpContext context, SnapshotLinks links, InklayerDbContext db, BlobStore blobs) =>
            ServeDocumentAsync(snapshotId, token, context, links, db, blobs, appOrigin, frameAncestors));
        group.MapGet("/a/{hash}", ServeAssetAsync);

        app.MapGet(OverlayPath, ServeOverlay).RequireHost(origin.Authority).ExcludeFromDescription();

        return app;
    }

    private static async Task<IResult> ServeDocumentAsync(
        Guid snapshotId, string token, HttpContext context, SnapshotLinks links, InklayerDbContext db, BlobStore blobs, Uri? appOrigin, string frameAncestors)
    {
        if (!links.IsValid(snapshotId, token))
        {
            return Results.NotFound();
        }

        // Routing ignores the trailing slash, but relative a/{hash} URLs need it to resolve against the right path.
        if (!context.Request.Path.Value!.EndsWith('/'))
        {
            return Results.Redirect($"/s/{snapshotId}/{token}/");
        }

        var documentHash = await db.Snapshots.Where(s => s.Id == snapshotId).Select(s => s.DocumentHash).SingleOrDefaultAsync(context.RequestAborted);
        var stream = documentHash is null ? null : blobs.OpenRead(documentHash);
        if (stream is null)
        {
            return Results.NotFound();
        }

        // A fresh nonce per response admits only the overlay script. The stored HTML can't contain a matching nonce.
        var nonce = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(18));
        var overlay = appOrigin is null
            ? ""
            : $"\n<script nonce=\"{nonce}\" src=\"{OverlayPath}?v={Uri.EscapeDataString(Hosting.AppVersion.Current)}\" " +
              $"data-app-origin=\"{appOrigin.GetLeftPart(UriPartial.Authority)}\"></script>\n";

        var headers = context.Response.Headers;
        headers.ContentSecurityPolicy = DocumentPolicy(nonce, frameAncestors);
        headers.CacheControl = "private, no-store";
        return Results.Stream(async body =>
        {
            await using (stream)
            {
                await stream.CopyToAsync(body, context.RequestAborted);
            }

            await body.WriteAsync(System.Text.Encoding.UTF8.GetBytes(overlay), context.RequestAborted);
        }, "text/html; charset=utf-8");
    }

    private static async Task<IResult> ServeAssetAsync(Guid snapshotId, string token, string hash, HttpContext context, SnapshotLinks links, InklayerDbContext db, BlobStore blobs)
    {
        if (!BlobStore.IsValidHash(hash) || !links.IsValid(snapshotId, token))
        {
            return Results.NotFound();
        }

        var contentType = await db.SnapshotAssets
            .Where(a => a.SnapshotId == snapshotId && a.Hash == hash)
            .Select(a => a.ContentType)
            .SingleOrDefaultAsync(context.RequestAborted);
        var stream = contentType is null ? null : blobs.OpenRead(hash);
        if (stream is null)
        {
            return Results.NotFound();
        }

        var headers = context.Response.Headers;
        headers.ContentSecurityPolicy = AssetPolicy;
        headers.CacheControl = "private, max-age=3600, immutable";
        // The page is sandboxed, so its requests come from an opaque ("null") origin. Fonts are fetched in CORS mode
        // and need this header, and a same-origin resource policy would block images. The token in the URL is what protects access.
        headers.AccessControlAllowOrigin = "*";
        headers["Cross-Origin-Resource-Policy"] = "cross-origin";
        return Results.Stream(stream, contentType);
    }

    private static IResult ServeOverlay(HttpContext context, IWebHostEnvironment environment)
    {
        var file = environment.WebRootFileProvider.GetFileInfo(OverlayPath.TrimStart('/'));
        if (!file.Exists)
        {
            return Results.NotFound();
        }

        var headers = context.Response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.CacheControl = "public, max-age=300";
        headers["Cross-Origin-Resource-Policy"] = "cross-origin";
        return Results.Stream(file.CreateReadStream(), "text/javascript; charset=utf-8");
    }

    private static bool IsSnapshotHost(HttpContext context, Uri origin) =>
        string.Equals(context.Request.Host.Host, origin.Host, StringComparison.OrdinalIgnoreCase)
        && (context.Request.Host.Port ?? DefaultPort(context.Request.Scheme)) == origin.Port;

    private static int DefaultPort(string scheme) => scheme == "https" ? 443 : 80;
}
