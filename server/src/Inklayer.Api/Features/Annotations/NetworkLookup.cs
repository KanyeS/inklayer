using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using Inklayer.Infrastructure;
using MaxMind.Db;

namespace Inklayer.Api.Features.Annotations;

/// <param name="Kind">"vpn" or "hosting" for a known VPN or hosting provider (often a VPN or proxy); else empty.</param>
internal sealed record NetworkInfo(string Network, string Country, string Kind);

/// <summary>Who owns the network an IP address is on, and where it is.</summary>
internal interface INetworkLookup
{
    /// <summary>Null for private addresses, or when it isn't known.</summary>
    NetworkInfo? Find(IPAddress address);
}

/// <summary>
/// The network a comment came from, for bug reports ("Telstra (Australia)", "NordVPN (Netherlands), likely a VPN"), from
/// DB-IP's free Lite databases (IP to ASN and IP to Country; CC BY 4.0, "IP data by DB-IP", https://db-ip.com). They're
/// downloaded once a month into the data folder and looked up on this server: addresses are never sent anywhere, and
/// aren't kept. <c>Inklayer:IpData:Enabled=false</c> turns this off.
/// </summary>
internal sealed partial class DbIpNetworkLookup(DataPaths paths, IHttpClientFactory http, TimeProvider clock, ILogger<DbIpNetworkLookup> logger)
    : BackgroundService, INetworkLookup
{
    private const string Source = "https://download.db-ip.com/free";
    private static readonly TimeSpan CheckEvery = TimeSpan.FromDays(1);
    private static readonly TimeSpan RefreshAfter = TimeSpan.FromDays(35);

    private readonly Lock swap = new();
    private Reader? asn;
    private Reader? country;

    private string Folder => Path.Combine(paths.Root, "ipdata");

    public NetworkInfo? Find(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (!IsPublic(address))
        {
            return null;
        }

        Reader? asnReader, countryReader;
        lock (swap)
        {
            (asnReader, countryReader) = (asn, country);
        }

        try
        {
            var owner = asnReader?.Find<Dictionary<string, object>>(address)?.GetValueOrDefault("autonomous_system_organization") as string ?? "";
            var place = countryReader?.Find<Dictionary<string, object>>(address) is { } found
                && found.GetValueOrDefault("country") is Dictionary<string, object> c
                && c.GetValueOrDefault("names") is Dictionary<string, object> names
                ? names.GetValueOrDefault("en") as string ?? ""
                : "";
            return owner.Length == 0 && place.Length == 0 ? null : new NetworkInfo(owner, place, KindOf(owner));
        }
        catch (Exception ex) when (ex is InvalidDatabaseException or ObjectDisposedException)
        {
            return null;
        }
    }

    /// <summary>Known VPN providers, then hosting providers (where VPNs and proxies run): matched in the network's name.</summary>
    private static readonly string[] Vpns =
    [
        "nordvpn", "tefincom", "mullvad", "31173 services", "express technologies", "expressvpn", "proton", "private internet access", "london trust media",
        "surfshark", "cyberghost", "kape", "windscribe", "ipvanish", "hide.me", "purevpn", "gz systems", "torguard", "astrill", "privado", "vyprvpn",
        "golden frog", "hotspot shield", "anchorfree", "pango", "tunnelbear", "cloudflare warp", "ivpn", "airvpn", "perfect privacy", "obfuscated",
    ];

    private static readonly string[] Hosting =
    [
        "amazon", "google cloud", "google llc", "microsoft", "azure", "digitalocean", "linode", "akamai", "vultr", "choopa", "ovh", "hetzner",
        "m247", "datacamp", "cdn77", "leaseweb", "contabo", "hostinger", "scaleway", "online s.a.s", "oracle", "alibaba", "tencent", "cloudflare",
        "fastly", "packethub", "datapacket", "zenlayer", "hostwinds", "ionos", "hosting", "server", "data center", "datacenter",
    ];

    internal static string KindOf(string owner)
    {
        var name = owner.ToLowerInvariant();
        return Vpns.Any(name.Contains) ? "vpn" : Hosting.Any(name.Contains) ? "hosting" : "";
    }

    /// <summary>Not loopback, private, link-local, carrier-grade NAT or unique-local: those say nothing about the network.</summary>
    internal static bool IsPublic(IPAddress address)
    {
        if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any))
        {
            return false;
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return !(b[0] == 10 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
                || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) || b[0] == 0 || b[0] >= 224);
        }

        return !(address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6UniqueLocal || address.IsIPv6Multicast);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RefreshAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogFailed(logger, ex);
            }

            try
            {
                await Task.Delay(CheckEvery, clock, stoppingToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }
    }

    /// <summary>Downloads the databases if they're missing or over a month old, then opens them.</summary>
    private async Task RefreshAsync(CancellationToken ct)
    {
        Directory.CreateDirectory(Folder);
        foreach (var name in new[] { "asn", "country" })
        {
            var file = Path.Combine(Folder, $"{name}.mmdb");
            if (!File.Exists(file) || clock.GetUtcNow().UtcDateTime - File.GetLastWriteTimeUtc(file) > RefreshAfter)
            {
                await DownloadAsync(name, file, ct);
            }
        }

        Open();
    }

    /// <summary>This month's file, or last month's if this month's isn't out yet.</summary>
    private async Task DownloadAsync(string name, string file, CancellationToken ct)
    {
        using var client = http.CreateClient(Notifications.NotificationDispatcher.HttpClientName);
        var now = clock.GetUtcNow();
        foreach (var month in new[] { now, now.AddMonths(-1) })
        {
            using var response = await client.GetAsync(new Uri($"{Source}/dbip-{name}-lite-{month:yyyy-MM}.mmdb.gz"), HttpCompletionOption.ResponseHeadersRead, ct);
            if (!response.IsSuccessStatusCode)
            {
                continue;
            }

            var temp = file + ".download";
            await using (var gz = new GZipStream(await response.Content.ReadAsStreamAsync(ct), CompressionMode.Decompress))
            await using (var output = File.Create(temp))
            {
                await gz.CopyToAsync(output, ct);
            }

            // Checked before it replaces the one in use.
            using (new Reader(temp, FileAccessMode.MemoryMapped))
            {
            }

            File.Move(temp, file, overwrite: true);
            return;
        }
    }

    internal void Open()
    {
        Reader? Load(string name)
        {
            var file = Path.Combine(Folder, $"{name}.mmdb");
            return File.Exists(file) ? new Reader(file, FileAccessMode.MemoryMapped) : null;
        }

        var (newAsn, newCountry) = (Load("asn"), Load("country"));
        Reader? oldAsn, oldCountry;
        lock (swap)
        {
            (oldAsn, oldCountry) = (asn, country);
            (asn, country) = (newAsn, newCountry);
        }

        oldAsn?.Dispose();
        oldCountry?.Dispose();
    }

    public override void Dispose()
    {
        asn?.Dispose();
        country?.Dispose();
        base.Dispose();
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Updating the IP network database failed")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}

/// <summary>When it's turned off: nothing is known.</summary>
internal sealed class NoNetworkLookup : INetworkLookup
{
    public NetworkInfo? Find(IPAddress address) => null;
}

internal static class NetworkLookupSetup
{
    public static IServiceCollection AddInklayerNetworkLookup(this IServiceCollection services, IConfiguration configuration)
    {
        if (configuration.GetValue("Inklayer:IpData:Enabled", true))
        {
            services.AddSingleton<DbIpNetworkLookup>();
            services.AddSingleton<INetworkLookup>(sp => sp.GetRequiredService<DbIpNetworkLookup>());
            services.AddHostedService(sp => sp.GetRequiredService<DbIpNetworkLookup>());
        }
        else
        {
            services.AddSingleton<INetworkLookup, NoNetworkLookup>();
        }

        return services;
    }
}
