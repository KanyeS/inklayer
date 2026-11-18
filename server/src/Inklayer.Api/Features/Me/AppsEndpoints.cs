using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Api.Auth;
using Inklayer.Infrastructure.Persistence;
using OpenIddict.Abstractions;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Inklayer.Api.Features.Me;

/// <summary>An app the person allowed to use Inklayer as them (such as Claude), and when.</summary>
internal sealed record ConnectedAppResponse(string ClientId, string Name, DateTime? AuthorizedAt);

/// <summary>
/// "Connected apps": the apps (MCP clients) a person allowed on the consent page. Disconnecting one revokes its
/// authorization and every token issued to it, so it has to ask again.
/// </summary>
internal static class AppsEndpoints
{
    public static IEndpointRouteBuilder MapAppsEndpoints(this IEndpointRouteBuilder app)
    {
        var apps = app.MapGroup("/api/me/apps").WithTags("Me").RequireAuthorization();
        apps.MapGet("/", ListAsync).WithSummary("Apps you've allowed to use Inklayer as you");
        apps.MapDelete("/{clientId}", DisconnectAsync).WithSummary("Disconnect an app: revokes its access and tokens");
        return app;
    }

    private static async Task<IResult> ListAsync(
        CurrentUser currentUser, IOpenIddictApplicationManager applications, IOpenIddictAuthorizationManager authorizations, CancellationToken ct)
    {
        var subject = currentUser.Id!.Value.ToString();
        var found = new Dictionary<string, ConnectedAppResponse>(StringComparer.Ordinal);
        await foreach (var authorization in authorizations.FindBySubjectAsync(subject, ct))
        {
            if (await authorizations.GetStatusAsync(authorization, ct) != Statuses.Valid
                || await authorizations.GetTypeAsync(authorization, ct) != AuthorizationTypes.Permanent
                || await authorizations.GetApplicationIdAsync(authorization, ct) is not { } applicationId
                || await applications.FindByIdAsync(applicationId, ct) is not { } application
                || await applications.GetClientIdAsync(application, ct) is not { } clientId
                || clientId == ExtensionClientSeeder.ClientId)
            {
                continue;
            }

            var authorizedAt = (await authorizations.GetCreationDateAsync(authorization, ct))?.UtcDateTime;
            if (!found.TryGetValue(clientId, out var existing) || existing.AuthorizedAt > authorizedAt)
            {
                found[clientId] = new ConnectedAppResponse(clientId, await applications.GetDisplayNameAsync(application, ct) ?? clientId, authorizedAt);
            }
        }

        return TypedResults.Ok(found.Values.OrderByDescending(a => a.AuthorizedAt).ToList());
    }

    private static async Task<IResult> DisconnectAsync(
        string clientId, CurrentUser currentUser, IOpenIddictApplicationManager applications, IOpenIddictAuthorizationManager authorizations,
        IOpenIddictTokenManager tokens, AuditLog audit, InklayerDbContext db, CancellationToken ct)
    {
        if (clientId == ExtensionClientSeeder.ClientId || await applications.FindByClientIdAsync(clientId, ct) is not { } application)
        {
            return TypedResults.NotFound();
        }

        var subject = currentUser.Id!.Value.ToString();
        var applicationId = await applications.GetIdAsync(application, ct);
        var revoked = 0;
        await foreach (var authorization in authorizations.FindAsync(subject, applicationId, status: null, type: null, scopes: null, ct))
        {
            if (await authorizations.TryRevokeAsync(authorization, ct))
            {
                revoked++;
            }
        }

        await foreach (var token in tokens.FindAsync(subject, applicationId, status: null, type: null, ct))
        {
            await tokens.TryRevokeAsync(token, ct);
        }

        if (revoked == 0)
        {
            return TypedResults.NotFound();
        }

        audit.Record("app_disconnected", null, "application", clientId);
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }
}
