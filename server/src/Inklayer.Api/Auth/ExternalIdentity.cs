using System.Security.Claims;

namespace Inklayer.Api.Auth;

/// <summary>The parts of a validated sign-in from Google or another OpenID Connect provider that Inklayer uses.</summary>
/// <param name="Provider">The configured provider id, e.g. <c>google</c> or <c>jumpcloud</c>.</param>
/// <param name="Subject">The provider's account id (<c>sub</c>), unique within the provider.</param>
/// <param name="EmailVerified">The provider vouches that the person controls <paramref name="Email"/>.</param>
/// <param name="VerifiedDomain">
/// A domain the provider proves the person belongs to, or null. For Google it is the Workspace domain (<c>hd</c> claim);
/// for other providers it is the email's domain when that domain is in the provider's <c>VerifiedDomains</c>.
/// Organisations that allow this domain take the person in automatically.
/// </param>
public sealed record ExternalIdentity(
    string Provider,
    string Subject,
    string Email,
    bool EmailVerified,
    string? Name,
    string? Picture,
    string? VerifiedDomain)
{
    /// <summary>The provider owns the email address itself (its domain is <see cref="VerifiedDomain"/>), not just one account using it.</summary>
    public bool IsDomainAuthority => VerifiedDomain is { Length: > 0 } && EmailDomain(Email) == VerifiedDomain;

    public static ExternalIdentity FromGoogle(ClaimsPrincipal principal)
    {
        ArgumentNullException.ThrowIfNull(principal);
        string? Get(string type) => principal.FindFirst(type)?.Value;

        return new ExternalIdentity(
            Provider: AuthSchemes.Google,
            Subject: Get("sub") ?? throw new InvalidOperationException("Google ID token has no 'sub' claim."),
            Email: NormalizeEmail(Get("email")),
            EmailVerified: IsTrue(Get("email_verified")),
            Name: Get("name"),
            Picture: Get("picture"),
            VerifiedDomain: Get("hd")?.Trim().ToLowerInvariant());
    }

    public static ExternalIdentity FromOidc(ClaimsPrincipal principal, InklayerAuthOptions.OidcProviderOptions provider)
    {
        ArgumentNullException.ThrowIfNull(principal);
        ArgumentNullException.ThrowIfNull(provider);
        string? Get(string type) => principal.FindFirst(type)?.Value;

        var email = NormalizeEmail(Get("email"));
        var domain = EmailDomain(email);
        var domainVerified = domain is not null && provider.VerifiedDomainSet.Contains(domain);
        var name = Get("name") ?? JoinName(Get("given_name"), Get("family_name"));

        return new ExternalIdentity(
            Provider: provider.Id,
            Subject: Get("sub") ?? throw new InvalidOperationException($"The ID token from '{provider.Id}' has no 'sub' claim."),
            Email: email,
            EmailVerified: domainVerified || IsTrue(Get("email_verified")),
            Name: name,
            Picture: Get("picture"),
            VerifiedDomain: domainVerified ? domain : null);
    }

    internal static string? EmailDomain(string email)
    {
        var at = email.LastIndexOf('@');
        return at > 0 && at < email.Length - 1 ? email[(at + 1)..] : null;
    }

    private static string NormalizeEmail(string? email) => (email ?? "").Trim().ToLowerInvariant();

    // Some providers send email_verified as a JSON boolean, others as the string "true".
    private static bool IsTrue(string? value) => string.Equals(value, "true", StringComparison.OrdinalIgnoreCase);

    private static string? JoinName(string? given, string? family) =>
        string.Join(' ', new[] { given, family }.Where(p => !string.IsNullOrWhiteSpace(p))) is { Length: > 0 } joined ? joined : null;
}
