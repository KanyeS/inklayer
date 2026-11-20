using System.ComponentModel.DataAnnotations;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>The non-secret settings of a tracker connection.</summary>
public sealed record TrackerSettings(string? Owner = null, string? Repo = null, string? ApiUrl = null,
    string? Site = null, string? ProjectKey = null, string? IssueType = null, string? Email = null, string? TeamId = null);

public sealed record CreatedIssue(string ExternalId, string Key, string Url);

/// <summary>An issue that already exists in the tracker, found by search or by its address or number.</summary>
public sealed record FoundIssue(string ExternalId, string Key, string Title, string Url,
    [property: AllowedValues(IssueStates.Open, IssueStates.Closed)] string State);

/// <summary>A comment on a tracker issue. <see cref="Body"/> is plain text or markdown.</summary>
public sealed record TrackerComment(string ExternalId, string AuthorName, string? AuthorUrl, string Body, DateTime CreatedAt, DateTime UpdatedAt);

/// <summary>Talks to one issue tracker. Methods throw with a readable message when the tracker refuses.</summary>
internal interface IIssueTracker
{
    Task TestAsync(TrackerSettings settings, string token, CancellationToken ct);

    Task<CreatedIssue> CreateAsync(TrackerSettings settings, string token, string title, string markdown, CancellationToken ct);

    /// <summary><see cref="IssueStates.Open"/> or <see cref="IssueStates.Closed"/>.</summary>
    Task<string> StateAsync(TrackerSettings settings, string token, string externalId, CancellationToken ct);

    Task CloseAsync(TrackerSettings settings, string token, string externalId, CancellationToken ct);

    /// <summary>
    /// The issue a pasted address or number points to (<c>#12</c>, <c>12</c>, <c>ABC-12</c>, <c>ENG-5</c>, or its URL).
    /// Throws <see cref="InvalidOperationException"/> when the reference belongs to another repository or project.
    /// </summary>
    Task<FoundIssue> GetAsync(TrackerSettings settings, string token, string reference, CancellationToken ct);

    /// <summary>Up to 10 open issues whose title matches <paramref name="query"/>, recently updated first; all open ones if it's empty.</summary>
    Task<IReadOnlyList<FoundIssue>> SearchAsync(TrackerSettings settings, string token, string query, CancellationToken ct);

    /// <summary>The issue's comments added or edited after <paramref name="since"/> (all of them, up to 100, when null), oldest first.</summary>
    Task<IReadOnlyList<TrackerComment>> CommentsAsync(TrackerSettings settings, string token, string externalId, DateTime? since, CancellationToken ct);

    /// <summary>Posts a comment on the issue; returns the comment's id.</summary>
    Task<string> AddCommentAsync(TrackerSettings settings, string token, string externalId, string markdown, CancellationToken ct);
}

internal sealed class Trackers(IHttpClientFactory httpClients)
{
    public IIssueTracker For(string kind) => kind switch
    {
        TrackerKinds.GitHub => new GitHubTracker(httpClients),
        TrackerKinds.Jira => new JiraTracker(httpClients),
        TrackerKinds.Linear => new LinearTracker(httpClients),
        TrackerKinds.AzureDevOps => new AzureDevOpsTracker(httpClients),
        TrackerKinds.GitLab => new GitLabTracker(httpClients),
        TrackerKinds.Forgejo => new ForgejoTracker(httpClients),
        _ => throw new InvalidOperationException($"Unknown tracker {kind}."),
    };

    internal static async Task<JsonNode?> SendAsync(IHttpClientFactory factory, HttpRequestMessage request, CancellationToken ct)
    {
        using var client = factory.CreateClient(Notifications.NotificationDispatcher.HttpClientName);
        using var response = await client.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            var detail = text.Length > 200 ? text[..200] + "…" : text;
            throw new HttpRequestException((int)response.StatusCode switch
            {
                401 or 403 => $"The tracker refused the token ({(int)response.StatusCode}). Check it has access. {detail}",
                404 => $"Not found (404). Check the repository, project or team. {detail}",
                _ => $"The tracker answered {(int)response.StatusCode}: {detail}",
            });
        }

        return text.Length == 0 ? null : JsonNode.Parse(text);
    }

    internal static StringContent Json(object body) => new(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

    internal static StringContent Json(object body, string mediaType) => new(JsonSerializer.Serialize(body), Encoding.UTF8, mediaType);

    /// <summary>The issue number in <c>#12</c>, <c>12</c>, or an address whose path matches <paramref name="pathPattern"/> followed by <c>/12</c>.</summary>
    /// <param name="pathPattern">A regular expression for the path before the number, such as the escaped <c>/acme/shop/issues</c>.</param>
    /// <param name="where">Names the repository or project in the error, such as <c>acme/shop</c>.</param>
    internal static string IssueNumber(string reference, string pathPattern, string where)
    {
        var text = reference.Trim();
        if (Regex.Match(text, @"^#?(\d{1,12})$") is { Success: true } plain)
        {
            return plain.Groups[1].Value;
        }

        if (Uri.TryCreate(text, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https")
        {
            var path = Uri.UnescapeDataString(uri.AbsolutePath).TrimEnd('/');
            if (Regex.Match(path, $"^{pathPattern}/(\\d{{1,12}})(?:/.*)?$", RegexOptions.IgnoreCase) is { Success: true } inUrl)
            {
                return inUrl.Groups[1].Value;
            }

            throw new InvalidOperationException($"That address isn't an issue in {where}.");
        }

        throw new InvalidOperationException("Give the issue's number, such as #12, or its address.");
    }

    /// <summary>The path of an instance address, for instances served under a folder (<c>https://acme.com/git</c> → <c>/git</c>).</summary>
    internal static string SitePath(string? site) =>
        site is { Length: > 0 } && Uri.TryCreate(site, UriKind.Absolute, out var uri) ? Uri.UnescapeDataString(uri.AbsolutePath).TrimEnd('/') : "";

    /// <summary>A timestamp from a tracker, in UTC. Accepts ISO 8601, including Jira's <c>+0000</c> offsets.</summary>
    internal static DateTime Time(JsonNode? node)
    {
        var text = node?.GetValue<string>();
        if (text is null)
        {
            return DateTime.UnixEpoch;
        }

        text = Regex.Replace(text, @"([+-]\d{2})(\d{2})$", "$1:$2");
        return DateTimeOffset.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal).UtcDateTime;
    }

    /// <summary>A UTC timestamp as ISO 8601 with a Z, for trackers' <c>since</c> filters.</summary>
    internal static string Iso(DateTime time) =>
        DateTime.SpecifyKind(time, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    /// <summary>The id a tracker gives as a number or a string, as a string.</summary>
    internal static string Id(JsonNode? node) => node switch
    {
        JsonValue v when v.TryGetValue<long>(out var n) => n.ToString(CultureInfo.InvariantCulture),
        JsonValue v when v.TryGetValue<string>(out var t) => t,
        _ => throw new InvalidOperationException("The tracker's answer had no id."),
    };

    /// <summary>HTML (Azure DevOps comments and descriptions) as plain text: line breaks kept, tags dropped, entities decoded.</summary>
    internal static string TextFromHtml(string html)
    {
        var text = Regex.Replace(html, @"<\s*(br|/p|/div|/li|/h\d)\s*/?>", "\n", RegexOptions.IgnoreCase);
        text = Regex.Replace(text, "<[^>]+>", "");
        return Regex.Replace(WebUtility.HtmlDecode(text), "\n{3,}", "\n\n").Trim();
    }

    /// <summary>Markdown-ish text as simple HTML, for trackers that take HTML: escaped, one line per <c>&lt;br&gt;</c>, with bold and links kept.</summary>
    internal static string HtmlFromText(string text)
    {
        var html = string.Join("<br>", text.Split('\n').Select(WebUtility.HtmlEncode));
        html = Regex.Replace(html, @"\*\*(.+?)\*\*", "<b>$1</b>");
        return Regex.Replace(html, @"\[([^\]]+)\]\((https?://[^)\s]+)\)", "<a href=\"$2\">$1</a>");
    }

    /// <summary>Comments edited after <paramref name="since"/>, oldest first, for trackers that can't filter themselves.</summary>
    internal static IReadOnlyList<TrackerComment> After(IEnumerable<TrackerComment> comments, DateTime? since) =>
        [.. comments.Where(c => since is null || c.UpdatedAt > since).OrderBy(c => c.CreatedAt)];
}
