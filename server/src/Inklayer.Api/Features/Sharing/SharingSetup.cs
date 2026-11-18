using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace Inklayer.Api.Features.Sharing;

internal static class SharingSetup
{
    /// <summary>Requests a minute per address to share links' API; <c>Inklayer:Sharing:PublicRequestsPerMinute</c>.</summary>
    public const int DefaultPublicRequestsPerMinute = 60;

    /// <summary>Share pages, their API, and the viewer's scripts and styles: reachable from outside the VPN while sharing is on.</summary>
    public static bool IsPublicPath(PathString path) =>
        path.StartsWithSegments("/s", StringComparison.Ordinal)
        || path.StartsWithSegments("/api/public", StringComparison.Ordinal)
        || path.StartsWithSegments("/assets", StringComparison.Ordinal);

    public static IServiceCollection AddInklayerSharing(this IServiceCollection services, IConfiguration configuration)
    {
        var perMinute = configuration.GetValue("Inklayer:Sharing:PublicRequestsPerMinute", DefaultPublicRequestsPerMinute);
        services.Configure<RateLimiterOptions>(o => o.AddPolicy(PublicShareEndpoints.RateLimitPolicy, context => RateLimitPartition.GetFixedWindowLimiter(
            context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions { PermitLimit = perMinute, Window = TimeSpan.FromMinutes(1) })));
        return services;
    }

    /// <summary>Share pages and their API: not indexed, no referrer sent to sites they link to, not cached.</summary>
    public static WebApplication UseInklayerShareHeaders(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path;
            if (path.StartsWithSegments("/s", StringComparison.Ordinal) || path.StartsWithSegments("/api/public", StringComparison.Ordinal))
            {
                context.Response.OnStarting(() =>
                {
                    var headers = context.Response.Headers;
                    headers["X-Robots-Tag"] = "noindex, nofollow";
                    headers["Referrer-Policy"] = "no-referrer";
                    if (string.IsNullOrEmpty(headers.CacheControl))
                    {
                        headers.CacheControl = "no-store";
                    }

                    return Task.CompletedTask;
                });
            }

            await next(context);
        });
        return app;
    }
}
