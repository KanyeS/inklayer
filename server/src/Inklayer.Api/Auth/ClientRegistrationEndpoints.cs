using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using OpenIddict.Abstractions;
using OpenIddict.EntityFrameworkCore.Models;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Inklayer.Api.Auth;

/// <summary>RFC 7591 client registration request. Only what public clients (such as MCP clients) need.</summary>
public sealed record ClientRegistrationRequest(
    [property: JsonPropertyName("client_name")] string? ClientName,
    [property: JsonPropertyName("redirect_uris")] string[]? RedirectUris,
    [property: JsonPropertyName("grant_types")] string[]? GrantTypes,
    [property: JsonPropertyName("response_types")] string[]? ResponseTypes,
    [property: JsonPropertyName("token_endpoint_auth_method")] string? TokenEndpointAuthMethod);

public sealed record ClientRegistrationResponse(
    [property: JsonPropertyName("client_id")] string ClientId,
    [property: JsonPropertyName("client_id_issued_at")] long ClientIdIssuedAt,
    [property: JsonPropertyName("client_name")] string ClientName,
    [property: JsonPropertyName("redirect_uris")] string[] RedirectUris,
    [property: JsonPropertyName("grant_types")] string[] GrantTypes,
    [property: JsonPropertyName("response_types")] string[] ResponseTypes,
    [property: JsonPropertyName("token_endpoint_auth_method")] string TokenEndpointAuthMethod,
    [property: JsonPropertyName("scope")] string Scope);

/// <summary>
/// Dynamic client registration (RFC 7591), so MCP clients such as Claude can sign in without an administrator setting them
/// up. Registering only gives an app an id: it can't do anything until a person signs in and allows it on the consent page,
/// and then only what that person can do.
/// <list type="bullet">
/// <item>Public clients only (PKCE, no secret).</item>
/// <item>Redirects to https addresses, or to the person's own machine (http://localhost, 127.0.0.1 or [::1], any port).</item>
/// <item>At most <see cref="MaxDynamicClients"/> registered apps; ones nobody allowed are pruned after a day.</item>
/// </list>
/// </summary>
internal static class ClientRegistrationEndpoints
{
    public const int MaxDynamicClients = 1000;

    /// <summary>When the app registered; OpenIddict doesn't keep this itself.</summary>
    public const string CreatedProperty = "inklayer:created";
    private const int MaxRedirectUris = 5;

    public static IEndpointRouteBuilder MapClientRegistrationEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/connect/register", RegisterAsync).ExcludeFromDescription().RequireRateLimiting(AuthenticationSetup.AuthRateLimitPolicy);
        return app;
    }

    private static async Task<IResult> RegisterAsync(
        ClientRegistrationRequest? request, HttpContext context, IOpenIddictApplicationManager applications, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        if (request is null)
        {
            return Error("invalid_client_metadata", "Send the client's metadata as JSON.");
        }

        if (request.TokenEndpointAuthMethod is { } method && method != "none")
        {
            return Error("invalid_client_metadata", "Only public clients are supported: token_endpoint_auth_method must be \"none\" (PKCE is required).");
        }

        if (request.GrantTypes?.Except([GrantTypes.AuthorizationCode, GrantTypes.RefreshToken]).Any() == true)
        {
            return Error("invalid_client_metadata", "Only the authorization_code and refresh_token grants are supported.");
        }

        if (request.ResponseTypes?.Except([ResponseTypes.Code]).Any() == true)
        {
            return Error("invalid_client_metadata", "Only the code response type is supported.");
        }

        var redirects = request.RedirectUris ?? [];
        if (redirects.Length is 0 or > MaxRedirectUris)
        {
            return Error("invalid_redirect_uri", $"Give between 1 and {MaxRedirectUris} redirect_uris.");
        }

        var parsed = new List<Uri>();
        foreach (var redirect in redirects)
        {
            if (!Uri.TryCreate(redirect, UriKind.Absolute, out var uri) || !IsAllowedRedirect(uri))
            {
                return Error("invalid_redirect_uri", $"\"{redirect}\" isn't allowed: use https, or http on localhost, 127.0.0.1 or [::1].");
            }

            parsed.Add(uri);
        }

        var dynamicCount = await db.Set<OpenIddictEntityFrameworkCoreApplication>()
            .CountAsync(a => a.ClientId != null && a.ClientId.StartsWith(McpResource.DynamicClientPrefix), ct);
        if (dynamicCount >= MaxDynamicClients)
        {
            return Error("invalid_client_metadata", "This server has too many registered apps. Ask an administrator.", StatusCodes.Status503ServiceUnavailable);
        }

        var name = (request.ClientName ?? "").Trim();
        name = name.Length == 0 ? "An MCP client" : name.Length > 100 ? name[..100] : name;
        var clientId = McpResource.DynamicClientPrefix + WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(18));
        var descriptor = new OpenIddictApplicationDescriptor
        {
            ClientId = clientId,
            ClientType = ClientTypes.Public,
            // Native apps may use http://localhost redirects; https-only apps are web apps.
            ApplicationType = parsed.All(u => u.Scheme == Uri.UriSchemeHttps) ? ApplicationTypes.Web : ApplicationTypes.Native,
            DisplayName = name,
            ConsentType = ConsentTypes.Explicit,
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
                Permissions.Prefixes.Scope + McpResource.Scope,
                // Tokens for this server's MCP endpoint (RFC 8707 resource), the one thing these apps are for.
                Permissions.Prefixes.Resource + McpResource.Uri(context.Request),
            },
            Requirements = { Requirements.Features.ProofKeyForCodeExchange },
            Properties = { [CreatedProperty] = JsonSerializer.SerializeToElement(clock.GetUtcNow()) },
        };
        foreach (var uri in parsed)
        {
            descriptor.RedirectUris.Add(uri);
        }

        await applications.CreateAsync(descriptor, ct);
        return TypedResults.Json(
            new ClientRegistrationResponse(
                clientId, clock.GetUtcNow().ToUnixTimeSeconds(), name, redirects,
                [GrantTypes.AuthorizationCode, GrantTypes.RefreshToken], [ResponseTypes.Code], "none", $"{McpResource.Scope} {Scopes.OfflineAccess}"),
            statusCode: StatusCodes.Status201Created);
    }

    /// <summary>https anywhere; http only back to the person's own machine. No fragments, no user info.</summary>
    internal static bool IsAllowedRedirect(Uri uri)
    {
        if (uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
        {
            return false;
        }

        if (uri.Scheme == Uri.UriSchemeHttps)
        {
            return true;
        }

        return uri.Scheme == Uri.UriSchemeHttp
            && (uri.Host == "localhost" || (IPAddress.TryParse(uri.Host.Trim('[', ']'), out var ip) && IPAddress.IsLoopback(ip)));
    }

    private static IResult Error(string error, string description, int status = StatusCodes.Status400BadRequest) =>
        TypedResults.Json(new Dictionary<string, string> { ["error"] = error, ["error_description"] = description }, statusCode: status);
}
