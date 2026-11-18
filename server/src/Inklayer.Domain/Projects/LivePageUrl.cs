namespace Inklayer.Domain.Projects;

/// <summary>
/// URL rules for live-page annotations:
/// <list type="bullet">
/// <item>A project's live sites are origins only (scheme, host and port).</item>
/// <item>A page's key is its origin and path. The query string and #hash are added only if the project says they matter.</item>
/// </list>
/// </summary>
public static class LivePageUrl
{
    public const int MaxLength = 2048;
    public const int MaxSites = 20;

    /// <summary>Turns <c>app.example.com</c> or <c>https://App.Example.com/</c> into <c>https://app.example.com</c>.</summary>
    public static bool TryNormalizeOrigin(string? input, out string origin)
    {
        origin = "";
        var text = input?.Trim() ?? "";
        if (text.Length == 0 || text.Length > MaxLength)
        {
            return false;
        }

        if (!text.Contains("://", StringComparison.Ordinal))
        {
            text = "https://" + text;
        }

        if (!TryParseWeb(text, out var uri) || uri.AbsolutePath != "/" || uri.Query.Length > 0 || uri.Fragment.Length > 0 || uri.UserInfo.Length > 0)
        {
            return false;
        }

        origin = OriginOf(uri);
        return true;
    }

    /// <summary>The page key for <paramref name="url"/>, or null if it isn't an absolute http(s) URL.</summary>
    public static string? Normalize(string? url, bool matchQuery, bool matchHash)
    {
        if (url is null || url.Length > MaxLength || !TryParseWeb(url, out var uri))
        {
            return null;
        }

        var path = uri.AbsolutePath;
        if (path.Length > 1 && path.EndsWith('/'))
        {
            path = path.TrimEnd('/');
            if (path.Length == 0)
            {
                path = "/";
            }
        }

        var key = OriginOf(uri) + path;
        if (matchQuery && uri.Query.Length > 1)
        {
            // Parameter order doesn't make a different page.
            var parameters = uri.Query[1..].Split('&', StringSplitOptions.RemoveEmptyEntries);
            Array.Sort(parameters, StringComparer.Ordinal);
            key += "?" + string.Join('&', parameters);
        }

        if (matchHash && uri.Fragment.Length > 1)
        {
            key += uri.Fragment;
        }

        return key.Length <= MaxLength ? key : null;
    }

    /// <summary>The origin of an absolute http(s) URL, e.g. <c>https://app.example.com:8443</c>, or null.</summary>
    public static string? OriginOf(string? url) => url is not null && TryParseWeb(url, out var uri) ? OriginOf(uri) : null;

    private static string OriginOf(Uri uri) => $"{uri.Scheme}://{uri.IdnHost}{(uri.IsDefaultPort ? "" : $":{uri.Port}")}";

    private static bool TryParseWeb(string text, out Uri uri) =>
        Uri.TryCreate(text, UriKind.Absolute, out uri!) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp) && uri.Host.Length > 0;
}
