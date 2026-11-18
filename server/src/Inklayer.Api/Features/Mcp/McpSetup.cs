using Inklayer.Api.Auth;
using Inklayer.Api.Features.Docs;

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
            .WithTools([typeof(InklayerTools)]);
        return services;
    }

    public static IEndpointRouteBuilder MapInklayerMcp(this IEndpointRouteBuilder app)
    {
        app.MapMcp(McpResource.Path).RequireAuthorization(McpResource.Policy).ExcludeFromDescription();
        return app;
    }
}
