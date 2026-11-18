using Inklayer.Api.Auth;

namespace Inklayer.Tests.Infrastructure;

/// <summary>Builds fake Google identities with unique emails, so tests sharing a database don't collide.</summary>
public static class Identities
{
    public static string UniqueEmail(string name = "user", string domain = "example.test") =>
        $"{name}-{Guid.NewGuid():N}@{domain}";

    public static GoogleIdentity Consumer(string? email = null, string? subject = null, bool emailVerified = true) =>
        new(subject ?? Guid.NewGuid().ToString("N"), email ?? UniqueEmail(), emailVerified, "Test User", null, HostedDomain: null);

    public static GoogleIdentity Workspace(string domain, string? subject = null) =>
        new(subject ?? Guid.NewGuid().ToString("N"), UniqueEmail(domain: domain), true, "Workspace User", null, HostedDomain: domain);
}
