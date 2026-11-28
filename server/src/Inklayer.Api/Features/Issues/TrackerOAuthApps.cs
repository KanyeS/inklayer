using System.Text.Json;
using Inklayer.Api.Auth;
using Inklayer.Domain.Issues;
using Inklayer.Domain.Settings;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Issues;

/// <summary>Where a tracker's OAuth app is set up.</summary>
public enum TrackerAppSource
{
    /// <summary>Not set up: people can't connect their own account to this tracker.</summary>
    None,

    /// <summary>The server's configuration (<c>GITHUB_CLIENT_ID</c> and so on). Changed there, then restart.</summary>
    Config,

    /// <summary>Added by an instance administrator on the Admin page. Takes effect straight away.</summary>
    Admin,
}

/// <summary>
/// A tracker OAuth app an administrator added, as stored: the client secret is encrypted with Data Protection.
/// <see cref="Url"/>: the instance, for GitHub (Enterprise Server), GitLab and Forgejo. <see cref="TenantId"/>: Azure DevOps' Entra tenant.
/// </summary>
internal sealed record StoredTrackerApp(
    string Kind, string ClientId, string? ProtectedClientSecret, string? Url, string? TenantId, DateTime AddedAt, Guid? AddedByUserId);

/// <summary>
/// The tracker OAuth apps in effect: those in the server's configuration (<see cref="TrackerOAuthOptions"/>), and for the
/// trackers it leaves out, those administrators added on the Admin page. Added ones are stored in
/// <see cref="InstanceSetting.TrackerApps"/> and work as soon as they're saved, so nobody has to edit <c>.env</c> or restart.
/// </summary>
internal sealed partial class TrackerOAuthApps(
    IOptions<TrackerOAuthOptions> configured,
    IServiceScopeFactory scopes,
    IDataProtectionProvider protection,
    TimeProvider clock,
    ILogger<TrackerOAuthApps> logger) : IHostedService, IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly IDataProtector _protector = protection.CreateProtector("Inklayer.TrackerApps.v1");
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    private volatile IReadOnlyList<StoredTrackerApp> _added = [];

    /// <summary>Added apps whose client secret can't be decrypted (the database was restored without the server's keys).</summary>
    private volatile IReadOnlySet<string> _secretUnreadable = new HashSet<string>();

    private volatile TrackerOAuthOptions? _current;

    /// <summary>The apps in effect: the configuration's, with the added ones filled in for trackers it doesn't set up.</summary>
    public TrackerOAuthOptions Current => _current ?? configured.Value;

    public IReadOnlyList<StoredTrackerApp> Added => _added;

    public bool NeedsSecret(string kind) => _secretUnreadable.Contains(kind);

    /// <summary>Where the app people connect through for this tracker is set up.</summary>
    public TrackerAppSource Source(string kind) =>
        Client(configured.Value, kind) is { IsConfigured: true } ? TrackerAppSource.Config
        : _added.Any(a => a.Kind == kind) ? TrackerAppSource.Admin
        : TrackerAppSource.None;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var saved = await db.InstanceSettings.AsNoTracking().SingleOrDefaultAsync(s => s.Key == InstanceSetting.TrackerApps, cancellationToken);
        Apply(saved is null ? [] : JsonSerializer.Deserialize<List<StoredTrackerApp>>(saved.Value, Json) ?? []);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    /// <summary>Adds or changes the app for a tracker. <paramref name="clientSecret"/> null keeps the current secret.</summary>
    public async Task SaveAsync(string kind, string clientId, string? clientSecret, string? url, string? tenantId, Guid userId, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            var existing = _added.FirstOrDefault(a => a.Kind == kind);
            var protectedSecret = clientSecret is null ? existing?.ProtectedClientSecret : _protector.Protect(clientSecret);
            var app = new StoredTrackerApp(kind, clientId, protectedSecret, url, tenantId, existing?.AddedAt ?? clock.GetUtcNow().UtcDateTime, existing?.AddedByUserId ?? userId);
            var apps = _added.Where(a => a.Kind != kind).Append(app).ToList();
            await PersistAsync(apps, userId, ct);
            Apply(apps);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public async Task RemoveAsync(string kind, Guid userId, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            var apps = _added.Where(a => a.Kind != kind).ToList();
            await PersistAsync(apps, userId, ct);
            Apply(apps);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void Dispose() => _writeLock.Dispose();

    private void Apply(List<StoredTrackerApp> stored)
    {
        var options = Copy(configured.Value);
        var unreadable = new HashSet<string>(StringComparer.Ordinal);
        foreach (var app in stored)
        {
            if (Client(options, app.Kind) is not { } client)
            {
                continue;
            }

            // The configuration wins if someone later set up the same tracker there.
            if (client.IsConfigured)
            {
                LogShadowed(logger, app.Kind);
                continue;
            }

            string secret;
            try
            {
                secret = app.ProtectedClientSecret is { } p ? _protector.Unprotect(p) : "";
            }
            catch (System.Security.Cryptography.CryptographicException)
            {
                LogSecretUnreadable(logger, app.Kind);
                unreadable.Add(app.Kind);
                continue;
            }

            client.ClientId = app.ClientId;
            client.ClientSecret = secret;
            switch (app.Kind)
            {
                case TrackerKinds.GitHub when app.Url is { Length: > 0 } web:
                    options.GitHub.WebUrl = web;
                    options.GitHub.ApiUrl = GitHubApiUrl(web);
                    break;
                case TrackerKinds.GitLab when app.Url is { Length: > 0 } gitlab:
                    options.GitLab.Url = gitlab;
                    break;
                case TrackerKinds.Forgejo when app.Url is { Length: > 0 } forgejo:
                    options.Forgejo.Url = forgejo;
                    break;
                case TrackerKinds.AzureDevOps when app.TenantId is { Length: > 0 } tenant:
                    options.AzureDevOps.TenantId = tenant;
                    break;
            }
        }

        _added = stored;
        _secretUnreadable = unreadable;
        _current = options;
    }

    /// <summary>The API of a GitHub: api.github.com for github.com, else a GitHub Enterprise Server's <c>/api/v3</c>.</summary>
    internal static string GitHubApiUrl(string webUrl) =>
        Uri.TryCreate(webUrl, UriKind.Absolute, out var u) && u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase)
            ? "https://api.github.com"
            : $"{webUrl.TrimEnd('/')}/api/v3";

    internal static TrackerOAuthOptions.OAuthClientOptions? Client(TrackerOAuthOptions o, string kind) => kind switch
    {
        TrackerKinds.GitHub => o.GitHub,
        TrackerKinds.GitLab => o.GitLab,
        TrackerKinds.Forgejo => o.Forgejo,
        TrackerKinds.Linear => o.Linear,
        TrackerKinds.Jira => o.Jira,
        TrackerKinds.AzureDevOps => o.AzureDevOps,
        _ => null,
    };

    private static TrackerOAuthOptions Copy(TrackerOAuthOptions o) => new()
    {
        GitHub = new() { ClientId = o.GitHub.ClientId, ClientSecret = o.GitHub.ClientSecret, WebUrl = o.GitHub.WebUrl, ApiUrl = o.GitHub.ApiUrl },
        GitLab = new() { ClientId = o.GitLab.ClientId, ClientSecret = o.GitLab.ClientSecret, Url = o.GitLab.Url },
        Forgejo = new() { ClientId = o.Forgejo.ClientId, ClientSecret = o.Forgejo.ClientSecret, Url = o.Forgejo.Url },
        Linear = new() { ClientId = o.Linear.ClientId, ClientSecret = o.Linear.ClientSecret },
        Jira = new() { ClientId = o.Jira.ClientId, ClientSecret = o.Jira.ClientSecret },
        AzureDevOps = new()
        {
            ClientId = o.AzureDevOps.ClientId, ClientSecret = o.AzureDevOps.ClientSecret, TenantId = o.AzureDevOps.TenantId,
            CertificatePath = o.AzureDevOps.CertificatePath, CertificatePassword = o.AzureDevOps.CertificatePassword,
        },
    };

    private async Task PersistAsync(List<StoredTrackerApp> apps, Guid userId, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var setting = await db.InstanceSettings.SingleOrDefaultAsync(s => s.Key == InstanceSetting.TrackerApps, ct);
        if (setting is null)
        {
            setting = new InstanceSetting { Key = InstanceSetting.TrackerApps, Value = "[]" };
            db.InstanceSettings.Add(setting);
        }

        setting.Value = JsonSerializer.Serialize(apps, Json);
        setting.UpdatedAt = clock.GetUtcNow().UtcDateTime;
        setting.UpdatedByUserId = userId;
        await db.SaveChangesAsync(ct);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "The {Kind} tracker app added on the Admin page is ignored: the server's configuration sets one up")]
    private static partial void LogShadowed(ILogger logger, string kind);

    [LoggerMessage(Level = LogLevel.Warning, Message =
        "The client secret of the {Kind} tracker app added on the Admin page can't be decrypted, so people can't connect accounts through it. " +
        "This happens when the database is restored without the server's keys (/data/keys). Enter the secret again under Admin → Tracker apps.")]
    private static partial void LogSecretUnreadable(ILogger logger, string kind);
}
