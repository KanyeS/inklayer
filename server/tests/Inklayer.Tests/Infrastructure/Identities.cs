using Inklayer.Api.Auth;

namespace Inklayer.Tests.Infrastructure;

/// <summary>Builds fake sign-in identities with unique emails, so tests sharing a database don't collide.</summary>
public static class Identities
{
    public static string UniqueEmail(string name = "user", string domain = "example.test") =>
        $"{name}-{Guid.NewGuid():N}@{domain}";

    /// <summary>A consumer Google account: any email address, no Workspace domain.</summary>
    public static ExternalIdentity Consumer(string? email = null, string? subject = null, bool emailVerified = true) =>
        new(AuthSchemes.Google, subject ?? Guid.NewGuid().ToString("N"), email ?? UniqueEmail(), emailVerified, "Test User", null, VerifiedDomain: null);

    /// <summary>A Google Workspace account in <paramref name="domain"/>.</summary>
    public static ExternalIdentity Workspace(string domain, string? subject = null, string? email = null) =>
        new(AuthSchemes.Google, subject ?? Guid.NewGuid().ToString("N"), email ?? UniqueEmail(domain: domain), true, "Workspace User", null, VerifiedDomain: domain);

    /// <summary>
    /// An account at the test's generic OIDC provider (<see cref="InklayerApiFactory.OidcProviderId"/>). Pass
    /// <paramref name="verifiedDomain"/> when the provider is configured as the authority for the email's domain.
    /// </summary>
    public static ExternalIdentity Oidc(string? email = null, string? subject = null, bool emailVerified = false, string? verifiedDomain = null) =>
        new(InklayerApiFactory.OidcProviderId, subject ?? Guid.NewGuid().ToString("N"), email ?? UniqueEmail(), emailVerified || verifiedDomain is not null, "SSO User", null, verifiedDomain);
}
