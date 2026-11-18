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
    // Note for Phase 3: the annotation overlay will need a nonce-based script-src for its own script only.
    private const string ContentSecurityPolicy =
        "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data:; " +
        "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox";

    public static WebApplication UseSnapshotOrigin(this WebApplication app)
    {
        var options = app.Services.GetRequiredService<IOptions<SnapshotOptions>>().Value;
        var origin = options.OriginUri;
        if (origin is null)
        {
            return app;
        }

        // On the snapshot host, refuse everything except /s/ routes. Health checks stay available so a proxy can probe either hostname.
        app.Use((context, next) =>
        {
            if (IsSnapshotHost(context, origin)
                && !context.Request.Path.StartsWithSegments("/s", StringComparison.Ordinal)
                && !context.Request.Path.StartsWithSegments("/health", StringComparison.Ordinal))
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return Task.CompletedTask;
            }

            return next(context);
        });

        var frameAncestors = Uri.TryCreate(options.AppOrigin, UriKind.Absolute, out var appOrigin)
            ? $"; frame-ancestors {appOrigin.GetLeftPart(UriPartial.Authority)}"
            : "";
        var policy = ContentSecurityPolicy + frameAncestors;

        var group = app.MapGroup("/s/{snapshotId:guid}/{token}").RequireHost(origin.Authority).ExcludeFromDescription()
            .AddEndpointFilter(async (context, next) =>
            {
                var headers = context.HttpContext.Response.Headers;
                headers.ContentSecurityPolicy = policy;
                headers.XContentTypeOptions = "nosniff";
                headers["Referrer-Policy"] = "no-referrer";
                headers["Cross-Origin-Resource-Policy"] = "same-origin";
                headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
                return await next(context);
            });

        group.MapGet("/", ServeDocumentAsync);
        group.MapGet("/a/{hash}", ServeAssetAsync);

        return app;
    }

    private static async Task<IResult> ServeDocumentAsync(Guid snapshotId, string token, HttpContext context, SnapshotLinks links, InklayerDbContext db, BlobStore blobs)
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

        context.Response.Headers.CacheControl = "private, max-age=600";
        return Results.Stream(stream, "text/html; charset=utf-8");
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

        context.Response.Headers.CacheControl = "private, max-age=3600, immutable";
        return Results.Stream(stream, contentType);
    }

    private static bool IsSnapshotHost(HttpContext context, Uri origin) =>
        string.Equals(context.Request.Host.Host, origin.Host, StringComparison.OrdinalIgnoreCase)
        && (context.Request.Host.Port ?? DefaultPort(context.Request.Scheme)) == origin.Port;

    private static int DefaultPort(string scheme) => scheme == "https" ? 443 : 80;
}
