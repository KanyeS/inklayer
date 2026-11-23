using Microsoft.Extensions.Options;
using OpenIddict.Abstractions;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Inklayer.Api.Auth;

/// <summary>
/// Registers (or updates) Inklayer's own public OAuth clients at startup, after database migrations:
/// <list type="bullet">
/// <item>The browser extension. Its redirect URIs are the official extension's
/// (<see cref="InklayerAuthOptions.OfficialExtensionRedirectUris"/>) plus any in
/// <see cref="InklayerAuthOptions.ExtensionRedirectUris"/>. First-party in the browser: consent is implicit.</item>
/// <item>The review helper (client/apps/review), which Claude Code runs on the person's computer to try pages in a
/// browser and leave comments with screenshots and recordings. It signs in through the browser to a loopback address
/// (<see cref="ReviewRedirectUris"/>). Any program on that computer could use the same client ID, so the person
/// allows it once on the consent page, and can disconnect it under "Connected apps".</item>
/// </list>
/// Unlike apps that register themselves (MCP clients), whose tokens only work on the MCP endpoint, these clients' tokens
/// work on the API.
/// </summary>
internal sealed class FirstPartyClientSeeder(
    IServiceProvider services,
    IOptions<InklayerAuthOptions> options) : IHostedService
{
    public const string ExtensionClientId = "inklayer-extension";
    public const string ReviewClientId = "inklayer-review";

    /// <summary>The review helper listens on the first of these ports that's free while signing in.</summary>
    public static readonly IReadOnlyList<Uri> ReviewRedirectUris =
    [
        new("http://127.0.0.1:47821/callback"),
        new("http://127.0.0.1:47822/callback"),
        new("http://127.0.0.1:47823/callback"),
    ];

    /// <summary>What comments made with a client's tokens say they came "via": the review helper's are Claude Code's.</summary>
    public static string ViaFor(string? clientId) => clientId == ReviewClientId ? "Claude Code" : "";

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using var scope = services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<IOpenIddictApplicationManager>();

        await SaveAsync(manager, Client(ExtensionClientId, "Inklayer browser extension", ConsentTypes.Implicit, options.Value.ExtensionRedirectUriList), cancellationToken);
        await SaveAsync(manager, Client(ReviewClientId, "Inklayer review helper (Claude Code)", ConsentTypes.Explicit, ReviewRedirectUris), cancellationToken);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static OpenIddictApplicationDescriptor Client(string clientId, string name, string consent, IEnumerable<Uri> redirectUris)
    {
        var descriptor = new OpenIddictApplicationDescriptor
        {
            ClientId = clientId,
            ClientType = ClientTypes.Public,
            ApplicationType = ApplicationTypes.Native,
            DisplayName = name,
            ConsentType = consent,
            Permissions =
            {
                Permissions.Endpoints.Authorization,
                Permissions.Endpoints.Token,
                Permissions.GrantTypes.AuthorizationCode,
                Permissions.GrantTypes.RefreshToken,
                Permissions.ResponseTypes.Code,
                Permissions.Scopes.Email,
                Permissions.Scopes.Profile,
                Permissions.Prefixes.Scope + Scopes.OfflineAccess,
            },
            Requirements = { Requirements.Features.ProofKeyForCodeExchange },
        };
        foreach (var uri in redirectUris)
        {
            descriptor.RedirectUris.Add(uri);
        }

        return descriptor;
    }

    private static async Task SaveAsync(IOpenIddictApplicationManager manager, OpenIddictApplicationDescriptor descriptor, CancellationToken ct)
    {
        var existing = await manager.FindByClientIdAsync(descriptor.ClientId!, ct);
        if (existing is null)
        {
            await manager.CreateAsync(descriptor, ct);
        }
        else
        {
            await manager.UpdateAsync(existing, descriptor, ct);
        }
    }
}
