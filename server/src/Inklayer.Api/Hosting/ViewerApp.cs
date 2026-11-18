namespace Inklayer.Api.Hosting;

/// <summary>
/// Serves the web viewer (a single-page app built into wwwroot) on the app host. Any path that isn't an API or
/// auth route falls back to index.html, so client-side routes like /projects/{id} work on reload.
/// </summary>
internal static class ViewerApp
{
    private static readonly string[] ServerPrefixes = ["/api", "/auth", "/connect", "/health", "/openapi"];

    public static WebApplication UseViewerApp(this WebApplication app)
    {
        app.UseStaticFiles(new StaticFileOptions
        {
            OnPrepareResponse = ctx =>
            {
                if (ctx.File.Name.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
                {
                    ctx.Context.Response.Headers.ContentSecurityPolicy = ViewerPolicy;
                }

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
            context.Response.Headers.ContentSecurityPolicy = ViewerPolicy;
            await context.Response.SendFileAsync(index);
        });
        return app;
    }

    /// <summary>The viewer's own CSP: only its bundled scripts, and no frames.</summary>
    internal const string ViewerPolicy =
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-src 'none'; " +
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
}
