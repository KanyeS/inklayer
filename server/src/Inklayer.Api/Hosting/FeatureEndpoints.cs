using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Infrastructure.Persistence;

namespace Inklayer.Api.Hosting;

/// <param name="Configured">On or off in the server's configuration (what it goes back to if no administrator had chosen).</param>
public sealed record FeatureSettingResponse(string Feature, string Name, string Description, bool Enabled, FeatureSource Source, bool Configured);

/// <summary>Only the features given change.</summary>
public sealed record UpdateFeaturesRequest(bool? Docs, bool? LiveCursors, bool? Mcp);

/// <summary>Which major features are on: everyone signed in can see; instance administrators change them (Admin panel).</summary>
internal static class FeatureEndpoints
{
    public static IEndpointRouteBuilder MapFeatureEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/features", async (FeatureSwitches switches, CancellationToken ct) => TypedResults.Ok(FeaturesResponse.From(await switches.StatesAsync(ct))))
            .WithTags("Features").RequireAuthorization().WithSummary("Which features are on, so apps can show or hide them");
        return app;
    }

    /// <summary>Mapped under the admin-only group.</summary>
    public static RouteGroupBuilder MapAdminFeatureEndpoints(this RouteGroupBuilder admin)
    {
        admin.MapGet("/features", async (FeatureSwitches switches, Microsoft.Extensions.Options.IOptions<FeatureOptions> options, CancellationToken ct) =>
            TypedResults.Ok(Settings(await switches.StatesAsync(ct), options.Value)))
            .WithSummary("Each major feature, whether it's on, and why");

        admin.MapPut("/features", async (UpdateFeaturesRequest request, FeatureSwitches switches, Microsoft.Extensions.Options.IOptions<FeatureOptions> options,
            CurrentUser currentUser, InklayerDbContext db, AuditLog audit, TimeProvider clock, CancellationToken ct) =>
        {
            var choices = new Dictionary<Feature, bool>();
            if (request.Docs is { } docs)
            {
                choices[Feature.Docs] = docs;
            }

            if (request.LiveCursors is { } cursors)
            {
                choices[Feature.LiveCursors] = cursors;
            }

            if (request.Mcp is { } mcp)
            {
                choices[Feature.Mcp] = mcp;
            }

            audit.Record(AuditActions.FeaturesChanged, null, "instance", (string?)null, choices.ToDictionary(c => c.Key.ToString(), c => c.Value));
            await switches.SaveAsync(choices, db, currentUser.Id, clock.GetUtcNow().UtcDateTime, ct);
            return TypedResults.Ok(Settings(await switches.StatesAsync(ct), options.Value));
        }).WithSummary("Turn features on or off for everyone. Takes effect straight away.");
        return admin;
    }

    private static List<FeatureSettingResponse> Settings(IReadOnlyDictionary<Feature, FeatureState> states, FeatureOptions options) =>
    [
        .. states.Select(s => new FeatureSettingResponse(
            char.ToLowerInvariant(s.Key.ToString()[0]) + s.Key.ToString()[1..], FeatureSwitchExtensions.Name(s.Key), Description(s.Key),
            s.Value.Enabled, s.Value.Source, options[s.Key])),
    ];

    private static string Description(Feature feature) => feature switch
    {
        Feature.Docs => "The organisation knowledge base: docs, the graph, live doc editing, and [[links]] between comments and docs.",
        Feature.LiveCursors => "See each other's cursors, selections and avatars on web pages and in docs.",
        Feature.Mcp => "Let AI assistants such as Claude use Inklayer as the person who signs them in (MCP). Connected apps keep their access but can't use it while this is off.",
        _ => "",
    };
}
