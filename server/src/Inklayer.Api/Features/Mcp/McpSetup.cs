using Inklayer.Api.Auth;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Hosting;
using ModelContextProtocol.Protocol;

namespace Inklayer.Api.Features.Mcp;

/// <summary>
/// The MCP endpoint (<c>/api/mcp</c>, Streamable HTTP). Clients sign in with OAuth like the extension; discovery, client
/// registration and consent are in <see cref="AuthenticationSetup"/> and <see cref="ClientRegistrationEndpoints"/>.
/// Stateless: each request stands alone, so nothing is kept in memory between calls.
/// </summary>
internal static class McpSetup
{
    public static IServiceCollection AddInklayerMcp(this IServiceCollection services)
    {
        services.AddScoped<DocText>();
        services.AddMcpServer(o =>
            {
                o.ServerInfo = new() { Name = "Inklayer", Version = typeof(McpSetup).Assembly.GetName().Version?.ToString() ?? "1.0.0" };
                o.ServerInstructions = InklayerTools.Instructions;
            })
            .WithHttpTransport(o => o.Stateless = true)
            .WithTools([typeof(InklayerTools)])
            // Tools of a turned-off feature (docs, issue trackers) are hidden and refused.
            .WithRequestFilters(filters =>
            {
                filters.AddListToolsFilter(next => async (context, ct) =>
                {
                    var result = await next(context, ct);
                    var off = await OffToolsAsync(context.Services!, ct);
                    result.Tools = [.. result.Tools.Where(t => !off.ContainsKey(t.Name))];
                    return result;
                });
                filters.AddCallToolFilter(next => async (context, ct) =>
                    (await OffToolsAsync(context.Services!, ct)).TryGetValue(context.Params!.Name, out var feature)
                        ? new() { IsError = true, Content = [new TextContentBlock { Text = $"{FeatureSwitchExtensions.Name(feature)} are turned off on this server." }] }
                        : await next(context, ct));
            });
        return services;
    }

    /// <summary>The tools whose feature is turned off, with that feature.</summary>
    private static async Task<Dictionary<string, Feature>> OffToolsAsync(IServiceProvider services, CancellationToken ct)
    {
        var states = await services.GetRequiredService<FeatureSwitches>().StatesAsync(ct);
        var off = new Dictionary<string, Feature>(StringComparer.Ordinal);
        foreach (var (feature, tools) in new[] { (Feature.Docs, InklayerTools.DocTools), (Feature.IssueTrackers, InklayerTools.IssueTools) })
        {
            if (!states[feature].Enabled)
            {
                foreach (var tool in tools)
                {
                    off[tool] = feature;
                }
            }
        }

        return off;
    }

    public static IEndpointRouteBuilder MapInklayerMcp(this IEndpointRouteBuilder app)
    {
        app.MapMcp(McpResource.Path).RequireAuthorization(McpResource.Policy).ExcludeFromDescription();
        return app;
    }
}
