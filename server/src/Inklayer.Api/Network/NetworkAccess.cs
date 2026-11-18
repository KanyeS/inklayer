using System.Net;
using System.Text.Json;
using Inklayer.Domain.Network;
using Inklayer.Domain.Settings;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Network;

/// <summary>
/// <c>Inklayer:Network</c>: optionally, only answer requests from certain networks, such as the company VPN.
/// <see cref="AllowedNetworks"/> is the starting list; once an instance administrator saves a list on the Admin page,
/// that list is used instead.
/// </summary>
public sealed class NetworkOptions
{
    public const string SectionName = "Inklayer:Network";

    /// <summary>Addresses and CIDR ranges, separated by commas or spaces, e.g. <c>10.8.0.0/16, 203.0.113.7</c>. Empty: every network.</summary>
    public string AllowedNetworks { get; set; } = "";

    /// <summary>Turns the restriction off whatever the list says: for recovery if administrators are locked out.</summary>
    public bool RestrictionDisabled { get; set; }
}

/// <summary>Where the list in force comes from.</summary>
public enum NetworkListSource
{
    /// <summary>No list: every network is allowed.</summary>
    None,

    /// <summary>The server's configuration (<c>INKLAYER_ALLOWED_NETWORKS</c>).</summary>
    Config,

    /// <summary>Saved by an instance administrator on the Admin page.</summary>
    Admin,
}

/// <summary>The allow list in force, cached in memory; the database is read once and updated through <see cref="Save"/>.</summary>
public sealed class NetworkAccess(IOptions<NetworkOptions> options, IServiceScopeFactory scopes) : IDisposable
{
    private readonly IpAllowList _configured = IpAllowList.Parse(options.Value.AllowedNetworks);
    private readonly SemaphoreSlim _loadLock = new(1, 1);
    private (IpAllowList List, NetworkListSource Source)? _current;

    public bool RestrictionDisabled { get; } = options.Value.RestrictionDisabled;

    public async Task<(IpAllowList List, NetworkListSource Source)> CurrentAsync(CancellationToken ct)
    {
        if (_current is { } current)
        {
            return current;
        }

        await _loadLock.WaitAsync(ct);
        try
        {
            if (_current is null)
            {
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
                var saved = await db.InstanceSettings.AsNoTracking().SingleOrDefaultAsync(s => s.Key == InstanceSetting.AllowedNetworks, ct);
                _current = saved is not null
                    ? (IpAllowList.Parse(saved.Value), NetworkListSource.Admin)
                    : (_configured, _configured.IsEmpty ? NetworkListSource.None : NetworkListSource.Config);
            }

            return _current.Value;
        }
        finally
        {
            _loadLock.Release();
        }
    }

    public void Dispose() => _loadLock.Dispose();

    /// <summary>Raised after an administrator saves a new list, so long-lived connections can be checked against it.</summary>
    public event Action<IpAllowList>? Changed;

    /// <summary>Call after saving the setting, so requests use the new list straight away.</summary>
    public void Save(IpAllowList list)
    {
        _current = (list, NetworkListSource.Admin);
        Changed?.Invoke(list);
    }

    /// <summary>Health checks and the machine itself are always allowed, so container health checks and local tools keep working.</summary>
    public static bool IsAlwaysAllowed(HttpContext context) =>
        context.Request.Path.StartsWithSegments("/health", StringComparison.Ordinal)
        || (context.Connection.RemoteIpAddress is { } ip && IPAddress.IsLoopback(ip));
}

internal static class NetworkAccessExtensions
{
    public static IServiceCollection AddInklayerNetworkAccess(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection(NetworkOptions.SectionName);
        services.Configure<NetworkOptions>(section);

        // Fail at startup, not on the first request, if the configured list is invalid.
        IpAllowList.Parse(section.Get<NetworkOptions>()?.AllowedNetworks);
        services.AddSingleton<NetworkAccess>();
        return services;
    }

    /// <summary>Refuses requests from outside the allowed networks. Goes right after the forwarded headers, so it sees the real client address.</summary>
    public static WebApplication UseInklayerNetworkAccess(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            var access = context.RequestServices.GetRequiredService<NetworkAccess>();
            if (access.RestrictionDisabled || NetworkAccess.IsAlwaysAllowed(context))
            {
                await next(context);
                return;
            }

            var (list, _) = await access.CurrentAsync(context.RequestAborted);
            var address = context.Connection.RemoteIpAddress;
            if (list.Allows(address))
            {
                await next(context);
                return;
            }

            await RefuseAsync(context, address);
        });
        return app;
    }

    private static async Task RefuseAsync(HttpContext context, IPAddress? address)
    {
        const string Title = "Inklayer is only available on your organisation's network.";
        var shown = address is null ? "unknown" : IpAllowList.Normalize(address).ToString();
        var detail = $"Connect to your VPN and try again. Your address: {shown}.";
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        context.Response.Headers.CacheControl = "no-store";

        var path = context.Request.Path;
        var wantsJson = path.StartsWithSegments("/api", StringComparison.Ordinal) || path.StartsWithSegments("/connect", StringComparison.Ordinal)
            || context.Request.Headers.Accept.Any(a => a?.Contains("json", StringComparison.OrdinalIgnoreCase) == true);
        if (wantsJson)
        {
            context.Response.ContentType = "application/problem+json";
            await context.Response.WriteAsync(JsonSerializer.Serialize(new { type = "about:blank", title = Title, status = 403, detail }));
            return;
        }

        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(
            $"<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Inklayer</title></head><body>" +
            $"<h1>{WebUtility.HtmlEncode(Title)}</h1><p>{WebUtility.HtmlEncode(detail)}</p></body></html>");
    }
}
