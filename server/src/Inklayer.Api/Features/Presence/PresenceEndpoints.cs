using Inklayer.Api.Access;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Presence;

/// <summary>A single-use ticket for opening the presence connection: <c>/api/presence/hub?access_token=…</c>.</summary>
public sealed record PresenceTicketResponse(string Ticket, int ExpiresInSeconds);

/// <summary>
/// Live presence: see the cursors and selections of people in your organisations who are on the same page.
/// The extension only connects for tabs where the user turned it on.
/// </summary>
internal static class PresenceEndpoints
{
    public const string HubPath = "/api/presence/hub";

    /// <summary>The docs hub (live co-editing) uses the same tickets.</summary>
    public const string DocsHubPath = "/api/docs/hub";

    public static IServiceCollection AddInklayerPresence(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<PresenceOptions>(configuration.GetSection(PresenceOptions.SectionName));
        services.AddSingleton<PresenceTickets>();
        services.AddSingleton<PresenceRegistry>();
        services.AddSingleton<PresenceRevalidator>();
        services.AddHostedService(sp => sp.GetRequiredService<PresenceRevalidator>());

        services.AddAuthentication().AddScheme<AuthenticationSchemeOptions, PresenceTicketHandler>(PresenceTicketHandler.SchemeName, null);

        services.AddSignalR(o =>
            {
                // Cursor messages are tiny; selections carry a text quote, which the extension trims to fit.
                o.MaximumReceiveMessageSize = 16 * 1024;
                o.KeepAliveInterval = TimeSpan.FromSeconds(15);
                o.ClientTimeoutInterval = TimeSpan.FromSeconds(60);
            })
            .AddHubOptions<PresenceHub>(o => o.AddFilter<PresenceRateFilter>())
            .AddHubOptions<Docs.DocsHub>(o =>
            {
                // Snapshots carry a whole doc (bytes are sent as base64 in JSON).
                o.MaximumReceiveMessageSize = 3 * 1024 * 1024;
                o.AddFilter<PresenceRateFilter>();
            });
        services.AddSingleton<Docs.DocsRegistry>();
        services.AddScoped<Docs.DocIndexer>();
        return services;
    }

    public static IEndpointRouteBuilder MapPresenceEndpoints(this IEndpointRouteBuilder app)
    {
        var presence = app.MapGroup("/api/presence").WithTags("Presence");
        presence.MapPost("/ticket", TicketAsync).RequireAuthorization()
            .WithSummary("A single-use ticket, valid for a few seconds, for opening the presence connection");

        // WebSockets only: the extension skips negotiation and connects straight to the hub.
        app.MapHub<PresenceHub>(HubPath, o => o.Transports = HttpTransportType.WebSockets);
        return app;
    }

    private static async Task<IResult> TicketAsync(CurrentUser currentUser, PresenceTickets tickets, IOptions<PresenceOptions> options, CancellationToken ct)
    {
        if (await currentUser.GetAsync(ct) is not { IsDisabled: false } user)
        {
            return Results.Unauthorized();
        }

        var lifetime = options.Value.TicketLifetime;
        var ticket = tickets.Issue(user.Id, user.DisplayName, user.SecurityStamp, lifetime);
        return Results.Ok(new PresenceTicketResponse(ticket, (int)lifetime.TotalSeconds));
    }
}
