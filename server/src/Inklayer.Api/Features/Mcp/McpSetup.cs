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
            // While docs are turned off, docs tools are hidden and refused.
            .WithRequestFilters(filters =>
            {
                filters.AddListToolsFilter(next => async (context, ct) =>
                {
                    var result = await next(context, ct);
                    if (!await DocsOnAsync(context.Services!, ct))
                    {
                        result.Tools = [.. result.Tools.Where(t => !InklayerTools.DocTools.Contains(t.Name))];
                    }

                    return result;
                });
                filters.AddCallToolFilter(next => async (context, ct) =>
                    InklayerTools.DocTools.Contains(context.Params!.Name) && !await DocsOnAsync(context.Services!, ct)
                        ? new() { IsError = true, Content = [new TextContentBlock { Text = "Docs are turned off on this server." }] }
                        : await next(context, ct));
            });
        return services;
    }

    private static Task<bool> DocsOnAsync(IServiceProvider services, CancellationToken ct) =>
        services.GetRequiredService<FeatureSwitches>().IsEnabledAsync(Feature.Docs, ct);

    public static IEndpointRouteBuilder MapInklayerMcp(this IEndpointRouteBuilder app)
    {
        app.MapMcp(McpResource.Path).RequireAuthorization(McpResource.Policy).ExcludeFromDescription();
        return app;
    }
}
