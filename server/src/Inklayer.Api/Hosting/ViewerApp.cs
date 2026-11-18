namespace Inklayer.Api.Hosting;

/// <summary>
/// Serves the web viewer (a single-page app built into wwwroot) on the app host. Any path that isn't an API or
/// auth route falls back to index.html, so client-side routes like /snapshots/{id} work on reload.
/// </summary>
internal static class ViewerApp
{
    private static readonly string[] ServerPrefixes = ["/api", "/auth", "/connect", "/s", "/health", "/openapi", "/_inklayer"];

    public static WebApplication UseViewerApp(this WebApplication app)
    {
        app.UseStaticFiles(new StaticFileOptions
        {
            OnPrepareResponse = ctx =>
            {
                // Vite fingerprints everything under /assets, so it can be cached forever.
                ctx.Context.Response.Headers.CacheControl = ctx.Context.Request.Path.StartsWithSegments("/assets", StringComparison.Ordinal)
                    ? "public, max-age=31536000, immutable"
                    : "no-cache";
            },
        });
        return app;
    }

    public static WebApplication MapViewerFallback(this WebApplication app)
    {
        var snapshotOrigin = app.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<Features.Snapshots.SnapshotOptions>>().Value.OriginUri;
        var policy = ViewerPolicy(snapshotOrigin);
        app.MapFallback(async context =>
        {
            var path = context.Request.Path;
            var index = app.Environment.WebRootFileProvider.GetFileInfo("index.html");
            if (ServerPrefixes.Any(p => path.StartsWithSegments(p, StringComparison.OrdinalIgnoreCase))
                || !HttpMethods.IsGet(context.Request.Method)
                || !index.Exists)
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }

            context.Response.ContentType = "text/html; charset=utf-8";
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.Headers.ContentSecurityPolicy = policy;
            await context.Response.SendFileAsync(index);
        });
        return app;
    }

    /// <summary>The viewer's own CSP: only its bundled scripts, and frames only from the snapshot origin.</summary>
    internal static string ViewerPolicy(Uri? snapshotOrigin) =>
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; " +
        $"frame-src {(snapshotOrigin is null ? "'none'" : snapshotOrigin.GetLeftPart(UriPartial.Authority))}; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
}
