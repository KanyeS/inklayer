namespace Inklayer.Api.Auth;

internal static class AuthSchemes
{
    /// <summary>For the MCP endpoint: bearer tokens, with MCP's challenge (pointing clients at the protected-resource metadata).</summary>
    public const string Mcp = "inklayer.mcp";

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

/// <summary>The MCP endpoint and what its tokens are for.</summary>
internal static class McpResource
{
    public const string Path = "/api/mcp";

    /// <summary>Lets a client use the MCP endpoint as the user.</summary>
    public const string Scope = "mcp";

    public const string Policy = "mcp";

    /// <summary>Client ids of apps that registered themselves (dynamic client registration) start with this.</summary>
    public const string DynamicClientPrefix = "dyn_";

    /// <summary>This server's origin, as the client sees it (forwarded headers are already applied).</summary>
    public static string Origin(HttpRequest request) => $"{request.Scheme}://{request.Host}{request.PathBase}";

    /// <summary>The resource MCP tokens are issued for, and the audience the MCP endpoint requires.</summary>
    public static string Uri(HttpRequest request) => Origin(request) + Path;
}

internal static class CsrfHeader
{
    /// <summary>Required on state-changing requests authenticated by cookie. Cross-site forms can't set it, and cross-origin scripts would need a CORS pre-flight that the server refuses.</summary>
    public const string Name = "X-Inklayer-Csrf";
}
