using Microsoft.Extensions.Options;
using OpenIddict.Abstractions;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Inklayer.Api.Auth;

/// <summary>
/// Registers (or updates) the browser extension as a public OAuth client. Its redirect URIs are the official extension's
/// (<see cref="InklayerAuthOptions.OfficialExtensionRedirectUris"/>) plus any in
/// <see cref="InklayerAuthOptions.ExtensionRedirectUris"/>. Runs at startup, after database migrations.
/// </summary>
internal sealed class ExtensionClientSeeder(
    IServiceProvider services,
    IOptions<InklayerAuthOptions> options) : IHostedService
{
    public const string ClientId = "inklayer-extension";

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using var scope = services.CreateAsyncScope();
        var manager = scope.ServiceProvider.GetRequiredService<IOpenIddictApplicationManager>();

        var descriptor = new OpenIddictApplicationDescriptor
        {
            ClientId = ClientId,
            ClientType = ClientTypes.Public,
            ApplicationType = ApplicationTypes.Native,
            DisplayName = "Inklayer browser extension",
            ConsentType = ConsentTypes.Implicit,
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
        foreach (var uri in options.Value.ExtensionRedirectUriList)
        {
            descriptor.RedirectUris.Add(uri);
        }

        var existing = await manager.FindByClientIdAsync(ClientId, cancellationToken);
        if (existing is null)
        {
            await manager.CreateAsync(descriptor, cancellationToken);
        }
        else
        {
            await manager.UpdateAsync(existing, descriptor, cancellationToken);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
