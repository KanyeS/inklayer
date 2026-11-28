using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;

namespace Inklayer.Api.Features.Docs;

/// <summary>What a link card shows. Anything the page doesn't say is null.</summary>
/// <param name="Url">The address, after any redirects.</param>
public sealed record LinkPreviewResponse(string Url, string? Title, string? Description, string? Image);

/// <summary>
/// Reads a web page's title, description and picture (OpenGraph tags, else its &lt;title&gt;) for a link card on a board.
/// <para>The server fetches the page on someone's behalf, so it only ever connects to public addresses: every connection
/// (redirects included) is checked after the name is looked up, and loopback, private, link-local (cloud metadata),
/// carrier-grade NAT, multicast and unspecified addresses are refused. No proxy is used, so that check is the one that
/// counts. Pages are read for at most a few seconds and the first 512 KB; answers are kept for an hour.</para>
/// </summary>
internal sealed partial class LinkPreviewer(IHttpClientFactory clients, IMemoryCache cache)
{
    public const string HttpClientName = "link-preview";
    private const int MaxBytes = 512 * 1024;
    private const int MaxText = 300;
    private static readonly TimeSpan CacheFor = TimeSpan.FromHours(1);

    public static void Configure(IServiceCollection services)
    {
        services.AddHttpClient(HttpClientName, c =>
            {
                c.Timeout = TimeSpan.FromSeconds(5);
                c.DefaultRequestHeaders.UserAgent.ParseAdd("Inklayer-LinkPreview/1.0");
                c.DefaultRequestHeaders.Accept.ParseAdd("text/html,application/xhtml+xml;q=0.9,*/*;q=0.1");
            })
            .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
            {
                UseProxy = false,
                AllowAutoRedirect = true,
                MaxAutomaticRedirections = 3,
                AutomaticDecompression = DecompressionMethods.All,
                UseCookies = false,
                ConnectTimeout = TimeSpan.FromSeconds(3),
                PooledConnectionLifetime = TimeSpan.FromMinutes(2),
                ConnectCallback = ConnectPublicAsync,
            });
        services.AddSingleton<LinkPreviewer>();
    }

    public async Task<LinkPreviewResponse> PreviewAsync(Uri url, CancellationToken ct)
    {
        var key = $"link-preview:{url.AbsoluteUri}";
        if (cache.TryGetValue(key, out LinkPreviewResponse? cached) && cached is not null)
        {
            return cached;
        }

        var preview = await FetchAsync(url, ct);
        cache.Set(key, preview, new MemoryCacheEntryOptions { AbsoluteExpirationRelativeToNow = CacheFor, Size = 1 });
        return preview;
    }

    private async Task<LinkPreviewResponse> FetchAsync(Uri url, CancellationToken ct)
    {
        var plain = new LinkPreviewResponse(url.AbsoluteUri, null, null, null);
        try
        {
            using var response = await clients.CreateClient(HttpClientName).GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            var final = response.RequestMessage?.RequestUri ?? url;
            if (!response.IsSuccessStatusCode || response.Content.Headers.ContentType?.MediaType is not ("text/html" or "application/xhtml+xml"))
            {
                return plain with { Url = final.AbsoluteUri };
            }

            var html = await ReadStartAsync(response, ct);
            return Parse(html, final);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or IOException or RegexMatchTimeoutException or OperationCanceledException && !ct.IsCancellationRequested)
        {
            return plain;
        }
    }

    private static async Task<string> ReadStartAsync(HttpResponseMessage response, CancellationToken ct)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var buffer = new byte[MaxBytes];
        var total = 0;
        int read;
        while (total < buffer.Length && (read = await stream.ReadAsync(buffer.AsMemory(total), ct)) > 0)
        {
            total += read;
        }

        var charset = response.Content.Headers.ContentType?.CharSet;
        Encoding encoding;
        try
        {
            encoding = string.IsNullOrEmpty(charset) ? Encoding.UTF8 : Encoding.GetEncoding(charset.Trim('"'));
        }
        catch (ArgumentException)
        {
            encoding = Encoding.UTF8;
        }

        return encoding.GetString(buffer, 0, total);
    }

    /// <summary>The preview from a page's HTML, with relative picture addresses made absolute against <paramref name="page"/>.</summary>
    internal static LinkPreviewResponse Parse(string html, Uri page)
    {
        var meta = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match tag in MetaTag().Matches(html))
        {
            var attrs = Attributes(tag.Value);
            var name = attrs.GetValueOrDefault("property") ?? attrs.GetValueOrDefault("name");
            if (name is not null && attrs.GetValueOrDefault("content") is { } content)
            {
                meta.TryAdd(name, content);
            }
        }

        var title = meta.GetValueOrDefault("og:title") ?? meta.GetValueOrDefault("twitter:title")
            ?? (TitleTag().Match(html) is { Success: true } t ? t.Groups[1].Value : null);
        var description = meta.GetValueOrDefault("og:description") ?? meta.GetValueOrDefault("twitter:description") ?? meta.GetValueOrDefault("description");
        var image = meta.GetValueOrDefault("og:image") ?? meta.GetValueOrDefault("twitter:image");
        return new LinkPreviewResponse(page.AbsoluteUri, Clean(title), Clean(description), Absolute(image, page));
    }

    private static Dictionary<string, string> Attributes(string tag)
    {
        var attrs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match a in Attribute().Matches(tag))
        {
            attrs.TryAdd(a.Groups["name"].Value, a.Groups["dq"].Success ? a.Groups["dq"].Value : a.Groups["sq"].Success ? a.Groups["sq"].Value : a.Groups["bare"].Value);
        }

        return attrs;
    }

    private static string? Clean(string? text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return null;
        }

        var decoded = Whitespace().Replace(WebUtility.HtmlDecode(text), " ").Trim();
        return decoded.Length == 0 ? null : decoded.Length > MaxText ? decoded[..MaxText].TrimEnd() + "…" : decoded;
    }

    private static string? Absolute(string? image, Uri page) =>
        image is not null && Uri.TryCreate(page, WebUtility.HtmlDecode(image.Trim()), out var uri) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp)
            ? uri.AbsoluteUri
            : null;

    /// <summary>Connects only to public addresses: the name is looked up here and each address checked before connecting.</summary>
    private static async ValueTask<Stream> ConnectPublicAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var addresses = IPAddress.TryParse(context.DnsEndPoint.Host, out var literal)
            ? [literal]
            : await Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, ct);
        var allowed = addresses.Where(IsPublic).ToArray();
        if (allowed.Length == 0)
        {
            throw new HttpRequestException("That address isn't on the public internet.");
        }

        var socket = new Socket(SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(allowed, context.DnsEndPoint.Port, ct);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    /// <summary>Whether an address is on the public internet (not this machine, a private network, link-local, CGNAT, multicast or reserved).</summary>
    internal static bool IsPublic(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (IPAddress.IsLoopback(address) || address.Equals(IPAddress.Any) || address.Equals(IPAddress.IPv6Any) || address.Equals(IPAddress.None))
        {
            return false;
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return !(b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224
                || (b[0] == 100 && b[1] >= 64 && b[1] <= 127) // carrier-grade NAT
                || (b[0] == 169 && b[1] == 254) // link-local, cloud metadata
                || (b[0] == 172 && b[1] >= 16 && b[1] <= 31)
                || (b[0] == 192 && b[1] == 168)
                || (b[0] == 192 && b[1] == 0 && b[2] == 0)
                || (b[0] == 198 && (b[1] == 18 || b[1] == 19)));
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            var b = address.GetAddressBytes();
            return !(address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast
                || (b[0] & 0xFE) == 0xFC // unique local fc00::/7
                || (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0D && b[3] == 0xB8) // documentation
                || (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xFF && b[3] == 0x9B)); // NAT64, could reach IPv4 private ranges
        }

        return false;
    }

    [GeneratedRegex("<meta\\b[^>]*>", RegexOptions.IgnoreCase, matchTimeoutMilliseconds: 1000)]
    private static partial Regex MetaTag();

    [GeneratedRegex("""(?<name>[a-zA-Z:_-]+)\s*=\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<bare>[^\s>]+))""", RegexOptions.None, matchTimeoutMilliseconds: 1000)]
    private static partial Regex Attribute();

    [GeneratedRegex("<title[^>]*>([^<]*)</title>", RegexOptions.IgnoreCase, matchTimeoutMilliseconds: 1000)]
    private static partial Regex TitleTag();

    [GeneratedRegex("\\s+")]
    private static partial Regex Whitespace();
}
