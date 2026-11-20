namespace Inklayer.Api.Hosting;

/// <summary>
/// Baseline security headers on every response. Headers a feature sets itself (a page's CSP, share links'
/// Referrer-Policy and Cache-Control) win: these are only added where the response doesn't have them yet.
/// </summary>
/// <remarks>
/// Cross-Origin-Embedder-Policy is left out on purpose: require-corp would block the sign-in provider's avatar images,
/// and nothing here needs cross-origin isolation. Cross-Origin-Resource-Policy is safe at same-origin because the
/// extension loads screenshots with fetch (CORS) from its background worker, never as no-cors images.
/// </remarks>
internal static class SecurityHeaders
{
    internal const string PermissionsPolicy =
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()";

    private static readonly string[] NoStorePrefixes = ["/api", "/auth", "/connect", "/openapi"];

    public static WebApplication UseInklayerSecurityHeaders(this WebApplication app)
    {
        app.Use((context, next) =>
        {
            // Registered first, so this OnStarting runs last and sees what later middleware and endpoints set.
            context.Response.OnStarting(() =>
            {
                var headers = context.Response.Headers;
                headers.TryAdd("X-Content-Type-Options", "nosniff");
                headers.TryAdd("Cross-Origin-Resource-Policy", "same-origin");
                headers.TryAdd("Cross-Origin-Opener-Policy", "same-origin");
                headers.TryAdd("Referrer-Policy", "strict-origin-when-cross-origin");
                headers.TryAdd("Permissions-Policy", PermissionsPolicy);

                // Server data is per-user and changes often; endpoints that want caching say so themselves.
                var path = context.Request.Path;
                if (string.IsNullOrEmpty(headers.CacheControl)
                    && NoStorePrefixes.Any(p => path.StartsWithSegments(p, StringComparison.OrdinalIgnoreCase)))
                {
                    headers.CacheControl = "no-store";
                }

                return Task.CompletedTask;
            });
            return next(context);
        });
        return app;
    }
}
