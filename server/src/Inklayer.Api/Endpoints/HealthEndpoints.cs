using Microsoft.AspNetCore.Diagnostics.HealthChecks;

namespace Inklayer.Api.Endpoints;

internal static class HealthEndpoints
{
    public const string ReadyTag = "ready";

    /// <summary>
    /// <c>/health/live</c>: the process is up (no dependency checks).
    /// <c>/health/ready</c>: dependencies such as the database are reachable.
    /// </summary>
    public static IEndpointRouteBuilder MapInklayerHealthChecks(this IEndpointRouteBuilder app)
    {
        app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
        app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains(ReadyTag) });
        return app;
    }
}
