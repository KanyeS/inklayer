namespace Inklayer.Api.Auth;

internal static class AuthSchemes
{
    /// <summary>Selects bearer tokens (extension) or the session cookie (web viewer) per request.</summary>
    public const string Default = "inklayer";

    public const string Cookie = "inklayer.cookie";

    public const string Google = "google";

    /// <summary>The authentication scheme for a sign-in provider id. Generic OIDC providers are prefixed so their ids can't clash with Inklayer's own schemes.</summary>
    public static string ForProvider(string providerId) => providerId == Google ? Google : "oidc." + providerId;
}

internal static class InklayerClaims
{
    public const string Subject = "sub";
    public const string Email = "email";
    public const string Name = "name";

    /// <summary>The user's security stamp at sign-in. A mismatch means the session or token was revoked.</summary>
    public const string SecurityStamp = "inklayer:stamp";
}

internal static class CsrfHeader
{
    /// <summary>Required on state-changing requests authenticated by cookie. Cross-site forms can't set it, and cross-origin scripts would need a CORS pre-flight that the server refuses.</summary>
    public const string Name = "X-Inklayer-Csrf";
}
