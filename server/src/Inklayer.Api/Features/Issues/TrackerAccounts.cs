using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Inklayer.Api.Features.Notifications;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <summary>How to call a tracker, and whose account it is: someone's own (<see cref="Account"/>), or the connection's shared one (null).</summary>
internal sealed record TrackerToken(TrackerAuth Auth, TrackerAccount? Account)
{
    public bool IsPersonal => Account is not null;
}

/// <summary>The person has no account of their own connected, and the connection has no shared one to fall back on.</summary>
internal sealed class TrackerAccountNeededException(string message) : InvalidOperationException(message);

/// <summary>What a <see cref="TrackerAccount"/> keeps in <see cref="TrackerAccount.Data"/>.</summary>
internal sealed record TrackerAccountData(string? RedirectUri, List<JiraSite>? Sites);

/// <summary>
/// Whose account Inklayer acts as in a tracker. Someone doing something (creating or linking an issue, replying, resolving)
/// acts as their own connected account where the tracker supports it, else as the connection's shared account. Background
/// checks use the shared account, else the account of someone who linked the issue. Access tokens that expire are
/// refreshed first; an account whose refresh token stops working is forgotten, so its owner is asked to connect again.
/// </summary>
internal sealed class TrackerAccounts(InklayerDbContext db, IntegrationSecrets secrets, TrackerOAuth oauth, TimeProvider clock)
{
    /// <summary>Trackers people can connect their own accounts to, when the server has the OAuth app.</summary>
    public static readonly string[] Kinds = [TrackerKinds.GitHub, TrackerKinds.GitLab, TrackerKinds.Forgejo, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps];

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>One refresh at a time per account: some trackers replace the refresh token each time, so a second would fail.</summary>
    private static readonly ConcurrentDictionary<Guid, SemaphoreSlim> Refreshing = new();

    /// <summary>How long before expiry a token is refreshed.</summary>
    private static readonly TimeSpan Early = TimeSpan.FromMinutes(2);

    public bool Available(string kind) => oauth.Available(kind);

    public bool PersonalFor(string kind, TrackerSettings settings) => oauth.PersonalFor(kind, settings);

    public bool PersonalFor(IssueTrackerConnection connection) => PersonalFor(connection.Kind, IssueService.SettingsOf(connection));

    public static TrackerAccountData DataOf(TrackerAccount account) =>
        account.Data is { Length: > 0 } data ? JsonSerializer.Deserialize<TrackerAccountData>(data, Json)! : new TrackerAccountData(null, null);

    public static string DataJson(TrackerAccountData data) => JsonSerializer.Serialize(data, Json);

    public Task<TrackerAccount?> AccountAsync(Guid userId, string kind, CancellationToken ct) =>
        db.TrackerAccounts.SingleOrDefaultAsync(a => a.UserId == userId && a.Kind == kind, ct);

    public TrackerToken? Shared(IssueTrackerConnection connection) =>
        connection.ProtectedToken is { } token ? new TrackerToken(secrets.Unprotect(token), null) : null;

    /// <summary>Acting as someone: their own account, else the shared one; null when there's neither.</summary>
    public async Task<TrackerToken?> ForUserAsync(IssueTrackerConnection connection, Guid userId, CancellationToken ct)
    {
        if (PersonalFor(connection) && await AccountAsync(userId, connection.Kind, ct) is { } account
            && await TokenAsync(account, IssueService.SettingsOf(connection), ct) is { } own)
        {
            return own;
        }

        return Shared(connection);
    }

    public async Task<TrackerToken> RequireForUserAsync(IssueTrackerConnection connection, Guid userId, CancellationToken ct) =>
        await ForUserAsync(connection, userId, ct) ?? throw new TrackerAccountNeededException(NeededMessage(connection.Kind));

    public static string NeededMessage(string kind) =>
        $"Connect your {TrackerKinds.Name(kind)} account to Inklayer first (on the home page, under Tracker accounts), or ask a project Admin to add a shared account.";

    /// <summary>
    /// For work no one is doing right now (checking issues): the shared account, else the first of <paramref name="people"/>
    /// (who linked the issue), then whoever connected the tracker, with an account of their own.
    /// </summary>
    public async Task<TrackerToken?> ForBackgroundAsync(IssueTrackerConnection connection, IEnumerable<Guid> people, CancellationToken ct)
    {
        if (Shared(connection) is { } shared)
        {
            return shared;
        }

        if (!PersonalFor(connection))
        {
            return null;
        }

        var ids = people.Append(connection.CreatedByUserId).Distinct().ToList();
        var accounts = await db.TrackerAccounts.Where(a => a.Kind == connection.Kind && ids.Contains(a.UserId)).ToListAsync(ct);
        foreach (var account in ids.Select(id => accounts.Find(a => a.UserId == id)).OfType<TrackerAccount>())
        {
            if (await TokenAsync(account, IssueService.SettingsOf(connection), ct) is { } token)
            {
                return token;
            }
        }

        return null;
    }

    /// <summary>
    /// The account's token for a connection with these settings: refreshed if it's about to expire, and for Jira, through
    /// the site's gateway. Null when the account can't be used any more (it was forgotten).
    /// </summary>
    public async Task<TrackerToken?> TokenAsync(TrackerAccount account, TrackerSettings settings, CancellationToken ct)
    {
        if (!await FreshAsync(account, ct))
        {
            return null;
        }

        var token = secrets.Unprotect(account.ProtectedAccessToken);
        if (account.Kind != TrackerKinds.Jira)
        {
            return new TrackerToken(new TrackerAuth(token, OAuth: true), account);
        }

        // Jira: the site's cloud id, from the sites the account allowed; asked again once in case a site was added since.
        var data = DataOf(account);
        var api = TrackerOAuth.JiraApi(data.Sites ?? [], settings.Site ?? "");
        if (api is null)
        {
            var sites = await oauth.JiraSitesAsync(token, ct);
            await db.TrackerAccounts.Where(a => a.Id == account.Id).ExecuteUpdateAsync(u => u.SetProperty(a => a.Data, DataJson(data with { Sites = sites })), ct);
            api = TrackerOAuth.JiraApi(sites, settings.Site ?? "")
                ?? throw new InvalidOperationException($"Your Atlassian account ({account.Login}) hasn't allowed Inklayer on {settings.Site}. Connect Jira again and choose that site.");
        }

        return new TrackerToken(new TrackerAuth(token, OAuth: true, ApiBase: api), account);
    }

    /// <summary>Refreshes the access token if it's about to expire. False when it can't be (the account is then forgotten).</summary>
    private async Task<bool> FreshAsync(TrackerAccount account, CancellationToken ct)
    {
        if (account.ExpiresAt is not { } expires || expires > clock.GetUtcNow().UtcDateTime + Early)
        {
            return true;
        }

        var gate = Refreshing.GetOrAdd(account.Id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            // Another request may have refreshed it while this one waited.
            var current = await db.TrackerAccounts.AsNoTracking().SingleOrDefaultAsync(a => a.Id == account.Id, ct);
            if (current is null)
            {
                return false;
            }

            if (current.ExpiresAt is { } now && now > clock.GetUtcNow().UtcDateTime + Early)
            {
                Copy(current, account);
                return true;
            }

            if (current.ProtectedRefreshToken is not { } refresh)
            {
                await ForgetAsync(account, ct);
                return false;
            }

            OAuthTokens tokens;
            try
            {
                tokens = await oauth.RefreshAsync(account.Kind, secrets.Unprotect(refresh), DataOf(current).RedirectUri, ct);
            }
            catch (Exception ex) when (ex is HttpRequestException { StatusCode: HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized } or InvalidOperationException)
            {
                // The refresh token was revoked or has expired: they connect again.
                await ForgetAsync(account, ct);
                return false;
            }

            account.ProtectedAccessToken = secrets.Protect(tokens.AccessToken);
            account.ProtectedRefreshToken = tokens.RefreshToken is { } r ? secrets.Protect(r) : current.ProtectedRefreshToken;
            account.ExpiresAt = tokens.ExpiresAt;
            account.UpdatedAt = clock.GetUtcNow().UtcDateTime;
            await db.TrackerAccounts.Where(a => a.Id == account.Id).ExecuteUpdateAsync(u => u
                .SetProperty(a => a.ProtectedAccessToken, account.ProtectedAccessToken)
                .SetProperty(a => a.ProtectedRefreshToken, account.ProtectedRefreshToken)
                .SetProperty(a => a.ExpiresAt, account.ExpiresAt)
                .SetProperty(a => a.UpdatedAt, account.UpdatedAt), ct);
            return true;
        }
        finally
        {
            gate.Release();
        }
    }

    private static void Copy(TrackerAccount from, TrackerAccount to)
    {
        to.ProtectedAccessToken = from.ProtectedAccessToken;
        to.ProtectedRefreshToken = from.ProtectedRefreshToken;
        to.ExpiresAt = from.ExpiresAt;
        to.Data = from.Data;
    }

    private Task ForgetAsync(TrackerAccount account, CancellationToken ct) =>
        db.TrackerAccounts.Where(a => a.Id == account.Id).ExecuteDeleteAsync(ct);

    /// <summary>The tracker refused someone's own token (they revoked it, say): forget the account, so they're asked to connect again.</summary>
    public async Task RefusedAsync(TrackerToken token, Exception error, CancellationToken ct)
    {
        if (token.Account is { } account && error is HttpRequestException { StatusCode: HttpStatusCode.Unauthorized })
        {
            await ForgetAsync(account, ct);
        }
    }

    /// <summary>Calls the tracker with the token; when it refuses someone's own token, forgets that account and rethrows.</summary>
    public async Task<T> WithAsync<T>(TrackerToken token, Func<TrackerAuth, Task<T>> call, CancellationToken ct)
    {
        try
        {
            return await call(token.Auth);
        }
        catch (HttpRequestException ex)
        {
            await RefusedAsync(token, ex, ct);
            throw;
        }
    }
}
