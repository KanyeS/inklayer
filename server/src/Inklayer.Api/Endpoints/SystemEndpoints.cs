using Inklayer.Api.Hosting;

namespace Inklayer.Api.Endpoints;

internal static class SystemEndpoints
{
    public static IEndpointRouteBuilder MapSystemEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/system").WithTags("System");

        group.MapGet("/version", () => TypedResults.Ok(new VersionResponse(AppVersion.Current)))
            .WithName("GetVersion")
            .WithSummary("Server version");

        return app;
    }
}

internal sealed record VersionResponse(string Version);
