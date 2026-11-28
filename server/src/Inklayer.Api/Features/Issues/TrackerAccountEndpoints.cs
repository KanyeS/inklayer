using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Inklayer.Api.Access;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Notifications;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <param name="Login">The connected account's name in the tracker; null when not connected.</param>
/// <param name="Site">The instance accounts are on (GitHub, GitLab, Forgejo): only connections to it use them.</param>
public sealed record TrackerAccountResponse(
    [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind,
    string Name, string? Login, string? Url, DateTime? ConnectedAt, string? Site);

/// <summary>
/// "Tracker accounts": people connect their own accounts (GitHub, GitLab, Forgejo, Jira, Linear, Azure DevOps) with OAuth,
/// so the issues, replies and closes they make from Inklayer show as them rather than as a shared account. Connecting is a
/// browser round trip: <c>connect</c> redirects to the tracker, which sends the person back to <c>callback</c>. The state is encrypted, tied to the person and to a
/// cookie in their browser, and uses PKCE.
/// </summary>
internal static class TrackerAccountEndpoints
{
    private const string Path = "/api/me/tracker-accounts";
    private const string CookieName = "inklayer.tracker-connect";
    private const string DefaultReturn = "/#tracker-accounts";
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private sealed record ConnectState(Guid UserId, string Kind, string ReturnTo, string Verifier, string Nonce, DateTimeOffset Expires);

    public static IEndpointRouteBuilder MapTrackerAccountEndpoints(this IEndpointRouteBuilder app)
    {
        var accounts = app.MapGroup(Path).WithTags("Me").RequireAuthorization();
        accounts.MapGet("/", ListAsync).Produces<List<TrackerAccountResponse>>()
            .WithSummary("Trackers you can connect your own account to, and the accounts you've connected");
        accounts.MapDelete("/{kind}", DisconnectAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Disconnect your account from a tracker");
        // Browser navigations, not API calls.
        accounts.MapGet("/{kind}/connect", Connect).ExcludeFromDescription();
        accounts.MapGet("/{kind}/callback", CallbackAsync).ExcludeFromDescription();
        return app;
    }

    private static async Task<IResult> ListAsync(CurrentUser currentUser, InklayerDbContext db, TrackerOAuth oauth, CancellationToken ct)
    {
        var userId = currentUser.Id!.Value;
        var mine = await db.TrackerAccounts.AsNoTracking().Where(a => a.UserId == userId).ToListAsync(ct);
        return TypedResults.Ok(TrackerAccounts.Kinds.Where(oauth.Available).Select(kind =>
        {
            var account = mine.Find(a => a.Kind == kind);
            return new TrackerAccountResponse(kind, TrackerKinds.Name(kind), account?.Login, account?.ProfileUrl, account?.CreatedAt, oauth.Instance(kind));
        }).ToList());
    }

    private static IResult Connect(
        string kind, string? returnTo, HttpContext http, CurrentUser currentUser, TrackerOAuth oauth, IDataProtectionProvider protection, TimeProvider clock)
    {
        if (!oauth.Available(kind))
        {
            return TypedResults.NotFound();
        }

        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        var nonce = Base64Url(RandomNumberGenerator.GetBytes(16));
        var state = Protector(protection).Protect(JsonSerializer.Serialize(
            new ConnectState(currentUser.Id!.Value, kind, LocalPath(returnTo), verifier, nonce, clock.GetUtcNow().Add(Lifetime))));
        http.Response.Cookies.Append(CookieName, nonce, CookieOptions(http));
        var challenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));
        return TypedResults.Redirect(oauth.AuthorizeUrl(kind, CallbackUrl(http, kind), state, challenge));
    }

    private static async Task<IResult> CallbackAsync(
        string kind, string? code, string? state, string? error, HttpContext http, CurrentUser currentUser, TrackerOAuth oauth, TrackerAccounts trackerAccounts,
        IDataProtectionProvider protection, InklayerDbContext db, IntegrationSecrets secrets, TimeProvider clock, CancellationToken ct)
    {
        ConnectState? connect = null;
        try
        {
            connect = JsonSerializer.Deserialize<ConnectState>(Protector(protection).Unprotect(state ?? ""));
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException or FormatException)
        {
        }

        var back = connect?.ReturnTo ?? DefaultReturn;
        var nonce = http.Request.Cookies[CookieName];
        http.Response.Cookies.Delete(CookieName, CookieOptions(http));
        var name = TrackerKinds.Name(kind);
        if (connect is null || connect.Kind != kind || connect.UserId != currentUser.Id || connect.Expires < clock.GetUtcNow() || nonce is null
            || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(nonce), Encoding.UTF8.GetBytes(connect.Nonce)) || !oauth.Available(kind))
        {
            return Back(back, $"{name} wasn't connected: the sign-in expired or was started in another browser. Try again.");
        }

        if (error is not null || code is null)
        {
            return Back(back, error == "access_denied" ? $"{name} wasn't connected: access was declined." : $"{name} wasn't connected ({error ?? "no code"}).");
        }

        var redirectUri = CallbackUrl(http, kind);
        OAuthTokens tokens;
        OAuthIdentity identity;
        try
        {
            tokens = await oauth.ExchangeAsync(kind, code, connect.Verifier, redirectUri, ct);
            identity = await oauth.IdentifyAsync(kind, tokens.AccessToken, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or JsonException or TrackerOAuthSetupException)
        {
            return Back(back, $"{name} wasn't connected: {ex.Message}");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var account = await trackerAccounts.AccountAsync(connect.UserId, kind, ct);
        if (account is null)
        {
            account = new TrackerAccount
            {
                UserId = connect.UserId, Kind = kind, ExternalUserId = identity.Id, Login = identity.Login, ProtectedAccessToken = "", CreatedAt = now,
            };
            db.TrackerAccounts.Add(account);
        }

        account.ExternalUserId = identity.Id.Length > 100 ? identity.Id[..100] : identity.Id;
        account.Login = identity.Login.Length > 200 ? identity.Login[..200] : identity.Login;
        account.ProfileUrl = identity.ProfileUrl is { Length: <= 500 } url && url.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ? url : null;
        account.ProtectedAccessToken = secrets.Protect(tokens.AccessToken);
        account.ProtectedRefreshToken = tokens.RefreshToken is { } refresh ? secrets.Protect(refresh) : null;
        account.ExpiresAt = tokens.ExpiresAt;
        account.Data = TrackerAccounts.DataJson(new TrackerAccountData(redirectUri, identity.Sites));
        account.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
        return TypedResults.Redirect(back);
    }

    private static async Task<IResult> DisconnectAsync(
        string kind, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets, TrackerOAuth oauth, CancellationToken ct)
    {
        var userId = currentUser.Id!.Value;
        var account = await db.TrackerAccounts.SingleOrDefaultAsync(a => a.UserId == userId && a.Kind == kind, ct);
        if (account is null)
        {
            return TypedResults.NotFound();
        }

        db.TrackerAccounts.Remove(account);
        await db.SaveChangesAsync(ct);

        // Take back the access in the tracker too, where it lets apps do that. Best effort: it's gone from Inklayer either way.
        if (oauth.Available(kind))
        {
            await oauth.RevokeAsync(kind, secrets.Unprotect(account.ProtectedAccessToken), ct);
        }

        return TypedResults.NoContent();
    }

    private static IDataProtector Protector(IDataProtectionProvider protection) => protection.CreateProtector("Inklayer.TrackerAccounts.Connect.v1");

    private static CookieOptions CookieOptions(HttpContext http) => new()
    {
        HttpOnly = true, Secure = http.Request.IsHttps, SameSite = SameSiteMode.Lax, Path = Path, MaxAge = Lifetime,
    };

    internal static string CallbackUrl(HttpContext http, string kind) => $"{McpResource.Origin(http.Request)}{Path}/{kind}/callback";

    /// <summary>Only paths on this server, so the connect link can't send people elsewhere.</summary>
    private static string LocalPath(string? returnTo) =>
        returnTo is { Length: > 0 and <= 500 } path && path.StartsWith('/') && !path.StartsWith("//", StringComparison.Ordinal) && !path.StartsWith("/\\", StringComparison.Ordinal)
            ? path
            : DefaultReturn;

    /// <summary>Back where the person started, with what went wrong in <c>trackerAccountError</c>.</summary>
    private static IResult Back(string returnTo, string message)
    {
        var hash = returnTo.IndexOf('#', StringComparison.Ordinal);
        var (path, fragment) = hash < 0 ? (returnTo, "") : (returnTo[..hash], returnTo[hash..]);
        return TypedResults.Redirect($"{path}{(path.Contains('?', StringComparison.Ordinal) ? '&' : '?')}trackerAccountError={E(message)}{fragment}");
    }

    private static string E(string value) => Uri.EscapeDataString(value);

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
