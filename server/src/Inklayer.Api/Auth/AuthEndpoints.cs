using System.Net;
using Microsoft.AspNetCore;
using Inklayer.Api.Access;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using OpenIddict.Abstractions;
using OpenIddict.Server.AspNetCore;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Inklayer.Api.Auth;

internal static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapInklayerAuthEndpoints(this IEndpointRouteBuilder app)
    {
        var auth = app.MapGroup("/auth").WithTags("Auth").RequireRateLimiting(AuthenticationSetup.AuthRateLimitPolicy);

        // Browser navigation: starts Google sign-in, then returns to returnUrl (local paths only).
        auth.MapGet("/login", (string? returnUrl, IOptions<InklayerAuthOptions> options) =>
            options.Value.Google.IsConfigured
                ? Results.Challenge(new AuthenticationProperties { RedirectUri = SafeReturnUrl(returnUrl) }, [AuthSchemes.Google])
                : Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "Google sign-in is not configured on this server."))
            .ExcludeFromDescription();

        auth.MapPost("/logout", async (HttpContext context) =>
        {
            await context.SignOutAsync(AuthSchemes.Cookie);
            return Results.NoContent();
        }).WithSummary("End the browser session");

        auth.MapGet("/denied", (string? reason) => Results.Content(DeniedPage(reason), "text/html; charset=utf-8"))
            .ExcludeFromDescription();

        var connect = app.MapGroup("/connect").ExcludeFromDescription().RequireRateLimiting(AuthenticationSetup.AuthRateLimitPolicy);
        connect.MapMethods("/authorize", [HttpMethods.Get, HttpMethods.Post], AuthorizeAsync);
        connect.MapPost("/token", TokenAsync);

        return app;
    }

    /// <summary>
    /// OAuth authorization endpoint for the browser extension. If there's no session cookie yet, the user is sent to Google
    /// sign-in and returned here. Consent is implicit because the extension is a first-party client.
    /// </summary>
    private static async Task<IResult> AuthorizeAsync(HttpContext context, InklayerDbContext db)
    {
        var request = context.GetOpenIddictServerRequest()
            ?? throw new InvalidOperationException("The OpenID Connect request cannot be retrieved.");

        var session = await context.AuthenticateAsync(AuthSchemes.Cookie);
        if (!session.Succeeded)
        {
            var parameters = context.Request.HasFormContentType ? [.. context.Request.Form] : context.Request.Query.ToList();
            return Results.Challenge(
                new AuthenticationProperties { RedirectUri = context.Request.PathBase + context.Request.Path + QueryString.Create(parameters) },
                [AuthSchemes.Cookie]);
        }

        var userId = Guid.Parse(session.Principal!.FindFirst(InklayerClaims.Subject)!.Value);
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == userId, context.RequestAborted);
        if (user is null || user.IsDisabled)
        {
            return Forbid(Errors.AccessDenied, "The account is disabled.");
        }

        return Results.SignIn(PrincipalFactory.CreateTokenPrincipal(user, request.GetScopes()), properties: null, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    /// <summary>Exchanges an authorization code or refresh token. The user is re-checked every time, so disabling them or "sign out everywhere" stops refreshes.</summary>
    private static async Task<IResult> TokenAsync(HttpContext context, InklayerDbContext db)
    {
        var request = context.GetOpenIddictServerRequest()
            ?? throw new InvalidOperationException("The OpenID Connect request cannot be retrieved.");
        if (!request.IsAuthorizationCodeGrantType() && !request.IsRefreshTokenGrantType())
        {
            return Forbid(Errors.UnsupportedGrantType, "Only authorization_code and refresh_token are supported.");
        }

        var result = await context.AuthenticateAsync(OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
        var principal = result.Principal;
        var subject = principal?.GetClaim(Claims.Subject);
        var user = Guid.TryParse(subject, out var userId)
            ? await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == userId, context.RequestAborted)
            : null;

        if (user is null || user.IsDisabled || user.SecurityStamp != principal!.GetClaim(InklayerClaims.SecurityStamp))
        {
            return Forbid(Errors.InvalidGrant, "The token is no longer valid. Sign in again.");
        }

        return Results.SignIn(PrincipalFactory.CreateTokenPrincipal(user, principal!.GetScopes()), properties: null, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
    }

    private static IResult Forbid(string error, string description) => Results.Forbid(
        new AuthenticationProperties(new Dictionary<string, string?>
        {
            [OpenIddictServerAspNetCoreConstants.Properties.Error] = error,
            [OpenIddictServerAspNetCoreConstants.Properties.ErrorDescription] = description,
        }),
        [OpenIddictServerAspNetCoreDefaults.AuthenticationScheme]);

    internal static string SafeReturnUrl(string? returnUrl) =>
        returnUrl is { Length: > 0 } url && url[0] == '/' && (url.Length == 1 || (url[1] != '/' && url[1] != '\\'))
            ? url
            : "/";

    private static string DeniedPage(string? reason)
    {
        var message = reason switch
        {
            nameof(SignInDenialReason.NotInvited) => "Your Google account hasn't been invited to this Inklayer server. Ask an administrator to invite your email address.",
            nameof(SignInDenialReason.EmailNotVerified) => "Your Google account's email address isn't verified.",
            nameof(SignInDenialReason.Disabled) => "Your account has been disabled by an administrator.",
            nameof(SignInDenialReason.AccountConflict) => "This email address is already linked to a different Google account. Ask an administrator for help.",
            "GoogleError" => "Google sign-in didn't complete. Please try again.",
            _ => "You don't have access to this page.",
        };

        return $"""
            <!DOCTYPE html>
            <html lang="en"><head><meta charset="utf-8"><title>Inklayer: access denied</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>body{"{"}font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5{"}"}</style>
            </head><body><h1>Can't sign you in</h1><p>{WebUtility.HtmlEncode(message)}</p><p><a href="/auth/login">Try a different account</a></p></body></html>
            """;
    }
}
