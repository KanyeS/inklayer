using System.Security.Claims;
using Inklayer.Domain.Users;
using OpenIddict.Abstractions;
using OpenIddict.Server.AspNetCore;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Inklayer.Api.Auth;

internal static class PrincipalFactory
{
    /// <summary>The principal stored in the web viewer's session cookie.</summary>
    public static ClaimsPrincipal CreateCookiePrincipal(User user)
    {
        var identity = new ClaimsIdentity(AuthSchemes.Cookie, InklayerClaims.Name, "role");
        identity.AddClaim(new Claim(InklayerClaims.Subject, user.Id.ToString()));
        identity.AddClaim(new Claim(InklayerClaims.Email, user.Email));
        identity.AddClaim(new Claim(InklayerClaims.Name, user.DisplayName));
        identity.AddClaim(new Claim(InklayerClaims.SecurityStamp, user.SecurityStamp));
        return new ClaimsPrincipal(identity);
    }

    private static readonly string[] SupportedScopes = [Scopes.OpenId, Scopes.Email, Scopes.Profile, Scopes.OfflineAccess, McpResource.Scope];

    /// <summary>The principal OpenIddict turns into authorization codes, refresh tokens and access tokens for the extension.</summary>
    public static ClaimsPrincipal CreateTokenPrincipal(User user, IEnumerable<string> requestedScopes)
    {
        var identity = new ClaimsIdentity(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme, Claims.Name, Claims.Role);
        identity.SetClaim(Claims.Subject, user.Id.ToString())
            .SetClaim(Claims.Email, user.Email)
            .SetClaim(Claims.Name, user.DisplayName)
            .SetClaim(InklayerClaims.SecurityStamp, user.SecurityStamp);

        var scopes = requestedScopes.Intersect(SupportedScopes, StringComparer.Ordinal).ToList();
        identity.SetScopes(scopes);

        // The security stamp has no destination: it never appears in access or identity tokens, but OpenIddict keeps it
        // in the authorization code and refresh token, so the token endpoint can check it on every refresh.
        identity.SetDestinations(claim => claim.Type switch
        {
            Claims.Subject => [Destinations.AccessToken, Destinations.IdentityToken],
            Claims.Email when scopes.Contains(Scopes.Email) => [Destinations.AccessToken, Destinations.IdentityToken],
            Claims.Name when scopes.Contains(Scopes.Profile) => [Destinations.AccessToken, Destinations.IdentityToken],
            Claims.Email or Claims.Name => [Destinations.AccessToken],
            _ => [],
        });

        return new ClaimsPrincipal(identity);
    }
}
