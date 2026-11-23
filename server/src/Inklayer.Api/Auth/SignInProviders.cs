using System.Collections.Concurrent;
using System.Text.Json;
using Inklayer.Domain.Settings;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Auth;

/// <summary>Where a sign-in provider is set up.</summary>
public enum SignInProviderSource
{
    /// <summary>The server's configuration (<c>GOOGLE_*</c>, <c>OIDC_*</c>, <c>Inklayer:Auth</c>). Changed there, then restart.</summary>
    Config,

    /// <summary>Added by an instance administrator on the Admin page. Takes effect straight away.</summary>
    Admin,
}

/// <param name="AllowInsecureHttp">Plain-HTTP trial or development: provider addresses may be <c>http</c>.</param>
internal sealed record SignInProviderSettings(bool AllowInsecureHttp);

/// <summary>A provider an administrator added, as stored: the client secret is encrypted with Data Protection.</summary>
internal sealed record StoredOidcProvider(
    string Id, string DisplayName, string Authority, string ClientId, string? ProtectedClientSecret, string Scopes, string VerifiedDomains,
    DateTime AddedAt, Guid? AddedByUserId);

/// <summary>
/// Every sign-in provider: Google and OpenID Connect providers from the server's configuration, then those administrators
/// added on the Admin page. Added ones are stored in <see cref="InstanceSetting.SignInProviders"/> and their authentication
/// schemes are added, changed and removed while the server runs, so nobody has to edit <c>.env</c> or restart for a second provider.
/// </summary>
internal sealed partial class SignInProviders(
    IOptions<InklayerAuthOptions> options,
    SignInProviderSettings settings,
    IServiceScopeFactory scopes,
    IDataProtectionProvider protection,
    IAuthenticationSchemeProvider schemes,
    IOptionsMonitorCache<OpenIdConnectOptions> handlerOptions,
    IServiceProvider services,
    TimeProvider clock,
    ILogger<SignInProviders> logger) : IHostedService, IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly IDataProtector _protector = protection.CreateProtector("Inklayer.SignInProviders.v1");
    private readonly SemaphoreSlim _writeLock = new(1, 1);

    /// <summary>Providers being checked before they're saved, by their temporary scheme name.</summary>
    private readonly ConcurrentDictionary<string, InklayerAuthOptions.OidcProviderOptions> _checking = new(StringComparer.Ordinal);

    private volatile IReadOnlyList<(StoredOidcProvider Stored, InklayerAuthOptions.OidcProviderOptions Options)> _added = [];

    /// <summary>
    /// Added providers whose client secret can't be decrypted: the database was restored without the server's keys
    /// (<c>/data/keys</c>), which aren't in the backup. They're left off the sign-in page until an administrator enters the secret again.
    /// </summary>
    private volatile IReadOnlySet<string> _secretUnreadable = new HashSet<string>();

    public bool AllowInsecureHttp => settings.AllowInsecureHttp;

    /// <summary>Every provider people can sign in with, Google first, then the configured ones, then the added ones.</summary>
    public IReadOnlyList<SignInProvider> All =>
        [.. options.Value.Providers, .. _added.Where(a => !_secretUnreadable.Contains(a.Options.Id)).Select(a => new SignInProvider(a.Options.Id, a.Options.DisplayNameOrId))];

    /// <summary>Providers from the server's configuration.</summary>
    public IReadOnlyList<SignInProvider> Configured => options.Value.Providers;

    /// <summary>Providers administrators added, including any whose secret must be entered again.</summary>
    public IReadOnlyList<StoredOidcProvider> Added => [.. _added.Select(a => a.Stored)];

    /// <summary>The added provider's client secret couldn't be decrypted, so it's off the sign-in page until it's entered again.</summary>
    public bool NeedsSecret(string id) => _secretUnreadable.Contains(id);

    /// <summary>The handler settings for an added provider, or one being checked, by scheme name.</summary>
    internal InklayerAuthOptions.OidcProviderOptions? ForScheme(string schemeName) =>
        _checking.TryGetValue(schemeName, out var checking) ? checking
        : _added.FirstOrDefault(a => AuthSchemes.ForProvider(a.Options.Id) == schemeName).Options;

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        await using (var scope = scopes.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            var saved = await db.InstanceSettings.AsNoTracking().SingleOrDefaultAsync(s => s.Key == InstanceSetting.SignInProviders, cancellationToken);
            var stored = saved is null ? [] : JsonSerializer.Deserialize<List<StoredOidcProvider>>(saved.Value, Json) ?? [];
            var configuredIds = Configured.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);

            var added = new List<(StoredOidcProvider, InklayerAuthOptions.OidcProviderOptions)>();
            var unreadable = new HashSet<string>(StringComparer.Ordinal);
            foreach (var provider in stored)
            {
                // The configuration wins if someone later set up the same id there.
                if (configuredIds.Contains(provider.Id))
                {
                    LogShadowed(logger, provider.Id);
                    continue;
                }

                if (TryToOptions(provider) is { } readable)
                {
                    added.Add((provider, readable));
                }
                else
                {
                    LogSecretUnreadable(logger, provider.Id);
                    unreadable.Add(provider.Id);
                    added.Add((provider, ToOptions(provider with { ProtectedClientSecret = null })));
                }
            }

            _added = added;
            _secretUnreadable = unreadable;
        }

        foreach (var (_, provider) in _added.Where(a => !_secretUnreadable.Contains(a.Options.Id)))
        {
            schemes.TryAddScheme(Scheme(provider));
        }

        // Nobody can sign in until a provider is set, so say how in the container's log rather than leave a blank sign-in page.
        if (All.Count == 0)
        {
            AuthenticationSetup.LogNoProviders(logger);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    /// <summary>
    /// Checks that a provider can be used: valid id and address, not taken, and its discovery document answers with the same
    /// issuer. Returns what's wrong, keyed by field, or nothing.
    /// </summary>
    public async Task<Dictionary<string, string[]>> CheckAsync(InklayerAuthOptions.OidcProviderOptions provider, bool isNew, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        if (isNew)
        {
            if (!InklayerAuthOptions.IsValidProviderId(provider.Id))
            {
                errors["id"] = ["Use 1-32 lower-case letters, digits or dashes, e.g. 'okta'."];
            }
            else if (provider.Id == AuthSchemes.Google || All.Any(p => p.Id == provider.Id))
            {
                errors["id"] = [$"There's already a provider with the id '{provider.Id}'."];
            }
        }

        if (!InklayerAuthOptions.IsValidAuthority(provider.Authority, settings.AllowInsecureHttp))
        {
            errors["authority"] = ["Enter the provider's issuer address, starting with https://."];
        }

        if (provider.ClientId.Length == 0)
        {
            errors["clientId"] = ["Enter the client ID from the app you registered at the provider."];
        }

        if (errors.Count > 0)
        {
            return errors;
        }

        // Fetch the discovery document the same way sign-in will: through the handler's own settings and backchannel.
        var name = "oidc-check." + Guid.NewGuid().ToString("N");
        _checking[name] = provider;
        try
        {
            // Resolved here: the factory depends on StoredOidcConfigurator, which depends on this class.
            var handler = services.GetRequiredService<IOptionsFactory<OpenIdConnectOptions>>().Create(name);
            // The handler built this client for the check; dispose it unless it wraps a handler someone else owns.
            using var backchannel = handler.BackchannelHttpHandler is null ? handler.Backchannel : null;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            var discovery = await handler.ConfigurationManager!.GetConfigurationAsync(timeout.Token);
            if (!string.Equals(discovery.Issuer.TrimEnd('/'), provider.Authority.TrimEnd('/'), StringComparison.Ordinal))
            {
                errors["authority"] = [$"The provider says its issuer is '{discovery.Issuer}'. Use that address."];
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            LogCheckFailed(logger, provider.Authority, ex);
            errors["authority"] = [$"Couldn't read {provider.Authority.TrimEnd('/')}/.well-known/openid-configuration from the server. Check the address, and that the server can reach it."];
        }
        finally
        {
            _checking.TryRemove(name, out _);
        }

        return errors;
    }

    /// <summary>Adds a provider or replaces an added one (keeping its secret when <paramref name="clientSecret"/> is null), and makes it usable straight away.</summary>
    public async Task<StoredOidcProvider> SaveAsync(InklayerAuthOptions.OidcProviderOptions provider, string? clientSecret, Guid userId, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            var current = _added.FirstOrDefault(a => a.Options.Id == provider.Id).Stored;
            var stored = new StoredOidcProvider(
                provider.Id, provider.DisplayName, provider.Authority, provider.ClientId,
                clientSecret is null ? current?.ProtectedClientSecret : clientSecret.Length > 0 ? _protector.Protect(clientSecret) : null,
                provider.Scopes, provider.VerifiedDomains,
                current?.AddedAt ?? clock.GetUtcNow().UtcDateTime, current?.AddedByUserId ?? userId);

            List<(StoredOidcProvider, InklayerAuthOptions.OidcProviderOptions)> added =
                [.. _added.Where(a => a.Options.Id != provider.Id), (stored, ToOptions(stored))];
            await PersistAsync(added.Select(a => a.Item1), userId, ct);
            _added = added;
            _secretUnreadable = _secretUnreadable.Where(id => id != provider.Id).ToHashSet(StringComparer.Ordinal);

            var scheme = AuthSchemes.ForProvider(provider.Id);
            handlerOptions.TryRemove(scheme);
            schemes.RemoveScheme(scheme);
            schemes.TryAddScheme(Scheme(added[^1].Item2));
            return stored;
        }
        finally
        {
            _writeLock.Release();
        }
    }

    /// <summary>Removes an added provider. People who used it can no longer sign in with it.</summary>
    public async Task RemoveAsync(string id, Guid userId, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            List<(StoredOidcProvider, InklayerAuthOptions.OidcProviderOptions)> added = [.. _added.Where(a => a.Options.Id != id)];
            await PersistAsync(added.Select(a => a.Item1), userId, ct);
            _added = added;
            _secretUnreadable = _secretUnreadable.Where(i => i != id).ToHashSet(StringComparer.Ordinal);

            var scheme = AuthSchemes.ForProvider(id);
            schemes.RemoveScheme(scheme);
            handlerOptions.TryRemove(scheme);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void Dispose() => _writeLock.Dispose();

    private async Task PersistAsync(IEnumerable<StoredOidcProvider> providers, Guid userId, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var setting = await db.InstanceSettings.SingleOrDefaultAsync(s => s.Key == InstanceSetting.SignInProviders, ct);
        if (setting is null)
        {
            setting = new InstanceSetting { Key = InstanceSetting.SignInProviders, Value = "[]" };
            db.InstanceSettings.Add(setting);
        }

        setting.Value = JsonSerializer.Serialize(providers.ToList(), Json);
        setting.UpdatedAt = clock.GetUtcNow().UtcDateTime;
        setting.UpdatedByUserId = userId;
        await db.SaveChangesAsync(ct);
    }

    private InklayerAuthOptions.OidcProviderOptions ToOptions(StoredOidcProvider stored) => new()
    {
        Id = stored.Id,
        DisplayName = stored.DisplayName,
        Authority = stored.Authority,
        ClientId = stored.ClientId,
        ClientSecret = stored.ProtectedClientSecret is { } secret ? _protector.Unprotect(secret) : "",
        Scopes = stored.Scopes,
        VerifiedDomains = stored.VerifiedDomains,
    };

    /// <summary>The handler settings, or null if the secret was encrypted with keys this server doesn't have.</summary>
    private InklayerAuthOptions.OidcProviderOptions? TryToOptions(StoredOidcProvider stored)
    {
        try
        {
            return ToOptions(stored);
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return null;
        }
    }

    private static AuthenticationScheme Scheme(InklayerAuthOptions.OidcProviderOptions provider) =>
        new(AuthSchemes.ForProvider(provider.Id), provider.DisplayNameOrId, typeof(OpenIdConnectHandler));

    [LoggerMessage(Level = LogLevel.Warning, Message = "The sign-in provider '{Id}' added on the Admin page is ignored: the server's configuration sets up a provider with the same id")]
    private static partial void LogShadowed(ILogger logger, string id);

    [LoggerMessage(Level = LogLevel.Warning, Message =
        "The client secret of the sign-in provider '{Id}' can't be decrypted, so it's left off the sign-in page. This happens when the " +
        "database is restored without the server's keys (/data/keys). Enter the secret again under Admin → Sign-in providers.")]
    private static partial void LogSecretUnreadable(ILogger logger, string id);

    [LoggerMessage(Level = LogLevel.Information, Message = "Checking the sign-in provider at {Authority} failed")]
    private static partial void LogCheckFailed(ILogger logger, string authority, Exception exception);
}

/// <summary>Gives the OpenID Connect handler its settings for providers added on the Admin page (and for checking one before it's saved).</summary>
internal sealed class StoredOidcConfigurator(SignInProviders providers) : IConfigureNamedOptions<OpenIdConnectOptions>
{
    public void Configure(string? name, OpenIdConnectOptions options)
    {
        if (name is not null && providers.ForScheme(name) is { } provider)
        {
            AuthenticationSetup.ConfigureOidc(options, provider, providers.AllowInsecureHttp);
        }
    }

    public void Configure(OpenIdConnectOptions options) => Configure(Options.DefaultName, options);
}
