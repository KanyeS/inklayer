using Inklayer.Api.Endpoints;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.HttpOverrides;
using Serilog;

namespace Inklayer.Api.Hosting;

internal static class HostingExtensions
{
    public static IServiceCollection AddInklayerHosting(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddProblemDetails();
        services.AddOpenApi();

        services.AddHealthChecks()
            .AddDbContextCheck<InklayerDbContext>("database", tags: [HealthEndpoints.ReadyTag]);

        // Inklayer runs behind a TLS-terminating reverse proxy such as Caddy or Traefik.
        // Proxies to trust are configured via ForwardedHeaders:KnownNetworks / KnownProxies.
        services.Configure<ForwardedHeadersOptions>(options =>
        {
            options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto | ForwardedHeaders.XForwardedHost;
            configuration.GetSection("ForwardedHeaders").Bind(options);
        });

        return services;
    }

    public static WebApplication UseInklayerHosting(this WebApplication app)
    {
        app.UseForwardedHeaders();
        app.UseExceptionHandler();
        app.UseStatusCodePages();
        app.UseSerilogRequestLogging(o =>
            o.GetLevel = (ctx, _, ex) => ex is not null || ctx.Response.StatusCode >= 500
                ? Serilog.Events.LogEventLevel.Error
                : ctx.Request.Path.StartsWithSegments("/health", StringComparison.Ordinal)
                    ? Serilog.Events.LogEventLevel.Verbose
                    : Serilog.Events.LogEventLevel.Information);
        return app;
    }
}
