using System.Security.Claims;

namespace Inklayer.Api.Auth;

/// <summary>The parts of a validated Google ID token that Inklayer uses.</summary>
/// <param name="HostedDomain">The Google Workspace domain (<c>hd</c> claim); null for consumer Google accounts.</param>
public sealed record GoogleIdentity(
    string Subject,
    string Email,
    bool EmailVerified,
    string? Name,
    string? Picture,
    string? HostedDomain)
{
    public static GoogleIdentity FromPrincipal(ClaimsPrincipal principal)
    {
        ArgumentNullException.ThrowIfNull(principal);
        string? Get(string type) => principal.FindFirst(type)?.Value;

        return new GoogleIdentity(
            Subject: Get("sub") ?? throw new InvalidOperationException("Google ID token has no 'sub' claim."),
            Email: (Get("email") ?? "").Trim().ToLowerInvariant(),
            EmailVerified: string.Equals(Get("email_verified"), "true", StringComparison.OrdinalIgnoreCase),
            Name: Get("name"),
            Picture: Get("picture"),
            HostedDomain: Get("hd")?.Trim().ToLowerInvariant());
    }
}
