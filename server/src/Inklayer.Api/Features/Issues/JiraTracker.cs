using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>Jira Cloud (REST v3). Token: an Atlassian API token for <see cref="TrackerSettings.Email"/>.</summary>
internal sealed class JiraTracker(IHttpClientFactory http) : IIssueTracker
{
    private static HttpRequestMessage Request(HttpMethod method, TrackerSettings s, string path, TrackerAuth token, object? body = null)
    {
        // Someone's own account goes through Atlassian's API gateway for the site; links still use the site's address.
        var api = token.ApiBase ?? s.Site!;
        var request = new HttpRequestMessage(method, $"{api.TrimEnd('/')}{path}") { Content = body is null ? null : Trackers.Json(body) };
        request.Headers.Authorization = token.OAuth
            ? new AuthenticationHeaderValue("Bearer", token.Token)
            : new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{s.Email}:{token.Token}")));
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    public async Task TestAsync(TrackerSettings s, TrackerAuth token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/project/{Uri.EscapeDataString(s.ProjectKey!)}", token);
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, CancellationToken ct)
    {
        var body = new
        {
            fields = new
            {
                project = new { key = s.ProjectKey },
                summary = title,
                issuetype = new { name = s.IssueType is { Length: > 0 } t ? t : "Bug" },
                description = Adf(markdown),
            },
        };
        using var request = Request(HttpMethod.Post, s, "/rest/api/3/issue", token, body);
        var issue = await Trackers.SendAsync(http, request, ct);
        var key = issue!["key"]!.GetValue<string>();
        return new CreatedIssue(key, key, $"{s.Site!.TrimEnd('/')}/browse/{key}");
    }

    public async Task<string> StateAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(externalId)}?fields=status", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue?["fields"]?["status"]?["statusCategory"]?["key"]?.GetValue<string>() == "done" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        // Any transition into the "done" category.
        using var list = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(externalId)}/transitions", token);
        var transitions = (await Trackers.SendAsync(http, list, ct))?["transitions"]?.AsArray() ?? [];
        var done = transitions.FirstOrDefault(t => t?["to"]?["statusCategory"]?["key"]?.GetValue<string>() == "done")
            ?? throw new InvalidOperationException("No workflow transition to Done for this issue.");
        using var request = Request(HttpMethod.Post, s, $"/rest/api/3/issue/{Uri.EscapeDataString(externalId)}/transitions", token,
            new { transition = new { id = done["id"]!.GetValue<string>() } });
        await Trackers.SendAsync(http, request, ct);
    }

    private static readonly string[] SearchFields = ["summary", "status"];

    /// <summary>Text as Atlassian Document Format, which Jira wants for descriptions and comments: one paragraph per line.</summary>
    private static object Adf(string text) => new
    {
        type = "doc",
        version = 1,
        content = text.Split('\n').Select(line => line.Length == 0
            ? (object)new { type = "paragraph", content = Array.Empty<object>() }
            : new { type = "paragraph", content = new object[] { new { type = "text", text = line } } }).ToArray(),
    };

    /// <summary>Atlassian Document Format as plain text: the text of each node, with paragraphs, headings and list items on their own lines.</summary>
    internal static string TextFromAdf(JsonNode? node)
    {
        var text = new StringBuilder();
        void Walk(JsonNode? n)
        {
            switch (n?["type"]?.GetValue<string>())
            {
                case "text":
                    text.Append(n["text"]?.GetValue<string>());
                    return;
                case "hardBreak":
                    text.Append('\n');
                    return;
                case "mention" or "emoji" or "status":
                    text.Append(n["attrs"]?["text"]?.GetValue<string>());
                    return;
                case "inlineCard" or "blockCard":
                    text.Append(n["attrs"]?["url"]?.GetValue<string>());
                    return;
            }

            foreach (var child in n?["content"]?.AsArray() ?? [])
            {
                Walk(child);
            }

            if (n?["type"]?.GetValue<string>() is "paragraph" or "heading" or "listItem" or "codeBlock" or "blockquote")
            {
                text.Append('\n');
            }
        }

        Walk(node);
        return text.ToString().Trim();
    }

    private static string Key(TrackerSettings s, string reference)
    {
        var text = reference.Trim();
        var project = s.ProjectKey!.Trim();
        if (Regex.IsMatch(text, @"^#?\d{1,12}$"))
        {
            return $"{project}-{text.TrimStart('#')}".ToUpperInvariant();
        }

        // ABC-12, or an address with it: /browse/ABC-12, ?selectedIssue=ABC-12.
        var match = Regex.Match(text, @"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9_]*-\d{1,12})(?![A-Za-z0-9])");
        if (!match.Success)
        {
            throw new InvalidOperationException($"Give the issue's key, such as {project}-12, or its address.");
        }

        var key = match.Groups[1].Value.ToUpperInvariant();
        return key.StartsWith(project.ToUpperInvariant() + "-", StringComparison.Ordinal)
            ? key
            : throw new InvalidOperationException($"{key} isn't in the {project} project.");
    }

    private static FoundIssue Found(TrackerSettings s, JsonNode issue)
    {
        var key = issue["key"]!.GetValue<string>();
        return new FoundIssue(key, key, issue["fields"]?["summary"]?.GetValue<string>() ?? "", $"{s.Site!.TrimEnd('/')}/browse/{key}",
            issue["fields"]?["status"]?["statusCategory"]?["key"]?.GetValue<string>() == "done" ? IssueStates.Closed : IssueStates.Open);
    }

    public async Task<FoundIssue> GetAsync(TrackerSettings s, TrackerAuth token, string reference, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(Key(s, reference))}?fields=summary,status", token);
        return Found(s, (await Trackers.SendAsync(http, request, ct))!);
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchAsync(TrackerSettings s, TrackerAuth token, string query, CancellationToken ct)
    {
        // JQL text search treats these as operators; searching words is enough.
        var words = Regex.Replace(query, @"[+\-&|!(){}\[\]^~*?\\:""']", " ").Trim();
        var jql = $"project = \"{s.ProjectKey!.Trim()}\" AND statusCategory != Done" + (words.Length > 0 ? $" AND summary ~ \"{words}*\"" : "") + " ORDER BY updated DESC";
        using var request = Request(HttpMethod.Post, s, "/rest/api/3/search/jql", token, new { jql, fields = SearchFields, maxResults = 10 });
        var issues = (await Trackers.SendAsync(http, request, ct))?["issues"]?.AsArray() ?? [];
        return [.. issues.Select(i => Found(s, i!))];
    }

    public async Task<IReadOnlyList<TrackerComment>> CommentsAsync(TrackerSettings s, TrackerAuth token, string externalId, DateTime? since, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(externalId)}/comment?orderBy=-created&maxResults=100", token);
        var comments = (await Trackers.SendAsync(http, request, ct))?["comments"]?.AsArray() ?? [];
        return Trackers.After(comments.Select(c => new TrackerComment(
            Trackers.Id(c!["id"]), c["author"]?["displayName"]?.GetValue<string>() ?? "Jira", null,
            TextFromAdf(c["body"]), Trackers.Time(c["created"]), Trackers.Time(c["updated"]))), since);
    }

    public async Task<string> AddCommentAsync(TrackerSettings s, TrackerAuth token, string externalId, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, s, $"/rest/api/3/issue/{Uri.EscapeDataString(externalId)}/comment", token, new { body = Adf(markdown) });
        return Trackers.Id((await Trackers.SendAsync(http, request, ct))?["id"]);
    }
}
