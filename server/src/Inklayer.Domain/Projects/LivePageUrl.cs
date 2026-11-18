namespace Inklayer.Domain.Projects;

/// <summary>
/// URL rules for live-page annotations. A comment's key is the page's origin and path, plus the query string and #hash only
/// if the person commenting chose them (e.g. <c>/watch?v=…</c> for one video rather than every <c>/watch</c> page), so
/// parts nobody chose (which may carry tokens) are never stored.
/// </summary>
public static class LivePageUrl
{
    public const int MaxLength = 2048;

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

    /// <summary>
    /// Every key a comment on <paramref name="url"/> can be stored under: with and without its query and #hash. Empty if
    /// <paramref name="url"/> isn't an absolute http(s) URL.
    /// </summary>
    public static IReadOnlyList<string> Candidates(string? url) =>
        new[] { (false, false), (true, false), (false, true), (true, true) }
            .Select(m => Normalize(url, m.Item1, m.Item2))
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)
            .ToList();

    /// <summary>The origin of an absolute http(s) URL, e.g. <c>https://app.example.com:8443</c>, or null.</summary>
    public static string? OriginOf(string? url) => url is not null && TryParseWeb(url, out var uri) ? OriginOf(uri) : null;

    private static string OriginOf(Uri uri) => $"{uri.Scheme}://{uri.IdnHost}{(uri.IsDefaultPort ? "" : $":{uri.Port}")}";

    private static bool TryParseWeb(string text, out Uri uri) =>
        Uri.TryCreate(text, UriKind.Absolute, out uri!) && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp) && uri.Host.Length > 0;
}
