using System.Net;
using Microsoft.AspNetCore;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Microsoft.AspNetCore.Antiforgery;
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

        // Browser navigation: starts sign-in with the chosen provider, then returns to returnUrl (local paths only).
        // Without a provider, the only configured one is used, or a page lets the user choose.
        auth.MapGet("/login", (string? provider, string? returnUrl, IOptions<InklayerAuthOptions> options) =>
        {
            var providers = options.Value.Providers;
            var safeReturnUrl = SafeReturnUrl(returnUrl);
            var chosen = provider is { Length: > 0 }
                ? providers.FirstOrDefault(p => p.Id == provider)
                : providers.Count == 1 ? providers[0] : null;

            if (chosen is not null)
            {
                return Results.Challenge(new AuthenticationProperties { RedirectUri = safeReturnUrl }, [AuthSchemes.ForProvider(chosen.Id)]);
            }

            if (provider is { Length: > 0 })
            {
                return Results.NotFound();
            }

            return providers.Count == 0
                ? Results.Problem(statusCode: StatusCodes.Status503ServiceUnavailable, title: "No sign-in provider is configured on this server.")
                : Results.Content(ChooserPage(providers, safeReturnUrl), "text/html; charset=utf-8");
        }).ExcludeFromDescription();

        auth.MapGet("/providers", (IOptions<InklayerAuthOptions> options) => options.Value.Providers)
            .WithSummary("The sign-in providers configured on this server");

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
        app.MapClientRegistrationEndpoints();

        return app;
    }

    /// <summary>
    /// OAuth authorization endpoint. If there's no session cookie yet, the user is sent to sign in (choosing a provider if
    /// there are several) and returned here.
    /// <list type="bullet">
    /// <item>The browser extension is first-party: consent is implicit.</item>
    /// <item>Apps that registered themselves (MCP clients such as Claude) need the person to allow them, once: a consent
    /// page, then a permanent authorization that later sign-ins reuse and the person can revoke under "Connected apps".</item>
    /// </list>
    /// Tokens carry the <c>resource</c> the client asked for (RFC 8707) as their audience; the MCP endpoint requires its own.
    /// </summary>
    private static async Task<IResult> AuthorizeAsync(
        HttpContext context, InklayerDbContext db, IOpenIddictApplicationManager applications, IOpenIddictAuthorizationManager authorizations,
        IAntiforgery antiforgery, AuditLog audit)
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

        // The only resource a token can be for is this server's MCP endpoint.
        var resources = request.GetResources();
        if (resources.Any(r => !string.Equals(r, McpResource.Uri(context.Request), StringComparison.Ordinal)))
        {
            return Forbid(Errors.InvalidTarget, $"The only resource this server issues tokens for is {McpResource.Uri(context.Request)}.");
        }

        var principal = PrincipalFactory.CreateTokenPrincipal(user, request.GetScopes());
        principal.SetResources(resources);
        var signIn = Results.SignIn(principal, properties: null, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);

        var application = await applications.FindByClientIdAsync(request.ClientId!, context.RequestAborted)
            ?? throw new InvalidOperationException("The client application can't be found.");
        if (await applications.GetConsentTypeAsync(application, context.RequestAborted) != ConsentTypes.Explicit)
        {
            return signIn;
        }

        // Allowed before, for these scopes: carry on.
        var applicationId = await applications.GetIdAsync(application, context.RequestAborted);
        var subject = user.Id.ToString();
        await foreach (var existing in authorizations.FindAsync(subject, applicationId, Statuses.Valid, AuthorizationTypes.Permanent, principal.GetScopes(), context.RequestAborted))
        {
            principal.SetAuthorizationId(await authorizations.GetIdAsync(existing, context.RequestAborted));
            return signIn;
        }

        var name = await applications.GetDisplayNameAsync(application, context.RequestAborted) ?? request.ClientId!;
        var decision = context.Request.HasFormContentType ? context.Request.Form["consent"].ToString() : "";
        if (decision is "allow" or "deny")
        {
            if (!await antiforgery.IsRequestValidAsync(context))
            {
                return Results.Content(ConsentPage.Render(context, antiforgery, request, name, user.DisplayName, expired: true), "text/html; charset=utf-8");
            }

            if (decision == "deny")
            {
                return Forbid(Errors.AccessDenied, "You didn't allow this app to use Inklayer.");
            }

            var authorization = await authorizations.CreateAsync(principal, subject, applicationId!, AuthorizationTypes.Permanent, principal.GetScopes(), context.RequestAborted);
            principal.SetAuthorizationId(await authorizations.GetIdAsync(authorization, context.RequestAborted));
            audit.Record("app_authorized", null, "application", request.ClientId, new { name, redirect = request.RedirectUri }, user.Id);
            await db.SaveChangesAsync(context.RequestAborted);
            return signIn;
        }

        return Results.Content(ConsentPage.Render(context, antiforgery, request, name, user.DisplayName, expired: false), "text/html; charset=utf-8");
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

        // Keep what the code or refresh token was for: its resources (audience) and the person's authorization of the app.
        var refreshed = PrincipalFactory.CreateTokenPrincipal(user, principal!.GetScopes());
        refreshed.SetResources(principal!.GetResources());
        refreshed.SetAuthorizationId(principal!.GetAuthorizationId());
        return Results.SignIn(refreshed, properties: null, OpenIddictServerAspNetCoreDefaults.AuthenticationScheme);
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
            nameof(SignInDenialReason.NotInvited) => "Your account hasn't been invited to this Inklayer server. Ask an administrator to invite your email address.",
            nameof(SignInDenialReason.EmailNotVerified) => "Your sign-in provider didn't confirm that your email address is verified.",
            nameof(SignInDenialReason.Disabled) => "Your account has been disabled by an administrator.",
            nameof(SignInDenialReason.AccountConflict) => "This email address already belongs to an Inklayer account that signs in a different way. Sign in the way you did before, or ask an administrator for help.",
            "ProviderError" => "Sign-in didn't complete. Please try again.",
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

    private static string ChooserPage(IEnumerable<SignInProvider> providers, string returnUrl)
    {
        var buttons = string.Concat(providers.Select(p =>
            $"""<p><a class="button" href="/auth/login?provider={Uri.EscapeDataString(p.Id)}&amp;returnUrl={Uri.EscapeDataString(returnUrl)}">Sign in with {WebUtility.HtmlEncode(p.DisplayName)}</a></p>"""));

        return $"""
            <!DOCTYPE html>
            <html lang="en"><head><meta charset="utf-8"><title>Inklayer: sign in</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>body{"{"}font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5{"}"}.button{"{"}display:inline-block;min-width:16rem;padding:.6rem 1rem;border:1px solid #ccc;border-radius:6px;text-decoration:none;color:inherit{"}"}</style>
            </head><body><h1>Sign in to Inklayer</h1>{buttons}</body></html>
            """;
    }
}
