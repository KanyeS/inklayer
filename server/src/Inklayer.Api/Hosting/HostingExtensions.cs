using Inklayer.Api.Endpoints;
using Inklayer.Api.Features.Sharing;
using Inklayer.Api.Network;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.HttpOverrides;
using Serilog;

namespace Inklayer.Api.Hosting;

internal static partial class HostingExtensions
{
    public static IServiceCollection AddInklayerHosting(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddProblemDetails();
        services.AddExceptionHandler<Activity.ErrorRecorder>();
        services.AddOpenApi(o => o.UseInklayerSchemaRules());

        services.AddHealthChecks()
            .AddDbContextCheck<InklayerDbContext>("database", tags: [HealthEndpoints.ReadyTag]);

        // Inklayer runs behind a TLS-terminating reverse proxy such as Caddy or Traefik.
        // ForwardedHeaders:KnownNetworks takes a list of CIDR ranges whose X-Forwarded-* headers are trusted,
        // e.g. the Docker bridge network 172.16.0.0/12. Loopback is always trusted.
        var knownNetworks = configuration.GetSection("ForwardedHeaders:KnownNetworks").Get<string[]>() ?? [];
        services.Configure<ForwardedHeadersOptions>(options =>
        {
            options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
            // Blank entries are skipped, so the self-host compose file can leave INKLAYER_TRUSTED_PROXY_NETWORK unset.
            foreach (var cidr in knownNetworks.Where(c => !string.IsNullOrWhiteSpace(c)))
            {
                options.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(cidr));
            }
        });

        return services;
    }

    public static WebApplication UseInklayerHosting(this WebApplication app)
    {
        app.UseInklayerSecurityHeaders();
        app.UseForwardedHeaders();
        app.UseUntrustedProxyWarning();
        app.UseInklayerNetworkAccess();
        app.UseInklayerFeatureSwitches();
        app.UseInklayerShareHeaders();
        app.UseExceptionHandler();
        app.UseStatusCodePages();
        // Only failures and slow requests by default: a line per request costs CPU the server is short of when it's busy.
        // Inklayer:Logging:EveryRequest=true logs them all again, for debugging.
        var everyRequest = app.Configuration.GetValue("Inklayer:Logging:EveryRequest", false);
        var slowMs = app.Configuration.GetValue("Inklayer:Logging:SlowRequestMs", 1000);
        app.UseSerilogRequestLogging(o => o.GetLevel = (ctx, elapsedMs, ex) => RequestLogLevel(ctx, elapsedMs, ex, everyRequest, slowMs));
        return app;
    }

    /// <summary>The level a finished request is logged at. Below Information, it isn't written (see appsettings.json).</summary>
    internal static Serilog.Events.LogEventLevel RequestLogLevel(HttpContext context, double elapsedMs, Exception? exception, bool everyRequest, int slowMs)
    {
        if (context.Items.ContainsKey(LoadShedding.RefusedItem))
        {
            return Serilog.Events.LogEventLevel.Debug; // one warning a minute says it's refusing; a line per refusal would add to the load
        }

        if (exception is not null || context.Response.StatusCode >= 500)
        {
            return Serilog.Events.LogEventLevel.Error;
        }

        if (context.Request.Path.StartsWithSegments("/health", StringComparison.Ordinal))
        {
            return Serilog.Events.LogEventLevel.Verbose;
        }

        // Live connections stay open for as long as the tab does: their "request" is always slow.
        if (elapsedMs >= slowMs && !context.WebSockets.IsWebSocketRequest)
        {
            return Serilog.Events.LogEventLevel.Warning;
        }

        return everyRequest ? Serilog.Events.LogEventLevel.Information : Serilog.Events.LogEventLevel.Debug;
    }

    private static int _warnedAboutProxy;

    /// <summary>
    /// The forwarded-headers middleware consumes X-Forwarded-* only from trusted proxies, so if they're still on the
    /// request, a proxy sent them and wasn't trusted. Then the server sees the proxy's address for everyone (one shared
    /// sign-in rate limit, a useless network allow list) and plain HTTP instead of HTTPS (cookies not marked Secure, and
    /// sign-in refusing the request). Say so once, with the fix, rather than leave people to turn HTTPS checks off.
    /// </summary>
    private static void UseUntrustedProxyWarning(this WebApplication app) => app.Use((context, next) =>
    {
        if (Volatile.Read(ref _warnedAboutProxy) == 0
            && context.Request.Headers.ContainsKey(ForwardedHeadersDefaults.XForwardedForHeaderName)
            && Interlocked.Exchange(ref _warnedAboutProxy, 1) == 0)
        {
            LogUntrustedProxy(app.Logger, context.Connection.RemoteIpAddress?.ToString() ?? "unknown");
        }

        return next(context);
    });

    [LoggerMessage(Level = LogLevel.Warning, Message =
        "A reverse proxy at {ProxyAddress} sent X-Forwarded-* headers, but its network isn't trusted, so they're ignored: " +
        "every request looks like it comes from the proxy, over plain HTTP. Add its network to ForwardedHeaders:KnownNetworks " +
        "(INKLAYER_TRUSTED_PROXY_NETWORK in the compose file, e.g. 172.16.0.0/12 for a proxy in Docker).")]
    private static partial void LogUntrustedProxy(Microsoft.Extensions.Logging.ILogger logger, string proxyAddress);
}
