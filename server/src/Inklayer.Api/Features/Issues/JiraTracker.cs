using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>Jira Cloud (REST v3). Token: an Atlassian API token for <see cref="TrackerSettings.Email"/>.</summary>
internal sealed partial class JiraTracker(IHttpClientFactory http) : IIssueTracker, IIssueTypes, IChildIssues, IIssueFiles, IBoardSync
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

    /// <summary>The project's issue types, without sub-tasks (they need a parent issue).</summary>
    public async Task<IReadOnlyList<string>> IssueTypesAsync(TrackerSettings s, TrackerAuth token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/project/{Uri.EscapeDataString(s.ProjectKey!)}", token);
        var project = await Trackers.SendAsync(http, request, ct);
        return (project?["issueTypes"]?.AsArray() ?? [])
            .Where(t => t?["subtask"]?.GetValue<bool>() != true)
            .Select(t => t?["name"]?.GetValue<string>())
            .OfType<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public Task<CreatedIssue> CreateAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, CancellationToken ct) =>
        CreateCoreAsync(s, token, title, markdown, s.IssueType is { Length: > 0 } t ? t : "Bug", null, ct);

    /// <summary>
    /// A sub-task of an ordinary issue, in the project's sub-task type; or, under an epic, an issue of the tracker's type
    /// in that epic. Sub-tasks can't have sub-tasks of their own.
    /// </summary>
    public async Task<CreatedIssue> CreateUnderAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, string parentExternalId, CancellationToken ct)
    {
        using var get = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(parentExternalId)}?fields=issuetype", token);
        var parentType = (await Trackers.SendAsync(http, get, ct))?["fields"]?["issuetype"];
        if (parentType?["subtask"]?.GetValue<bool>() == true)
        {
            throw new InvalidOperationException($"{parentExternalId} is a sub-task itself, and sub-tasks can't have their own. Choose its parent issue.");
        }

        var level = parentType?["hierarchyLevel"] is JsonValue v && v.TryGetValue<int>(out var n) ? n : 0;
        string type;
        if (level >= 1)
        {
            type = s.IssueType is { Length: > 0 } t ? t : "Bug";
        }
        else
        {
            using var project = Request(HttpMethod.Get, s, $"/rest/api/3/project/{Uri.EscapeDataString(s.ProjectKey!)}", token);
            type = ((await Trackers.SendAsync(http, project, ct))?["issueTypes"]?.AsArray() ?? [])
                .FirstOrDefault(x => x?["subtask"]?.GetValue<bool>() == true)?["name"]?.GetValue<string>()
                ?? throw new InvalidOperationException($"The Jira project {s.ProjectKey} has no sub-task issue type.");
        }

        return await CreateCoreAsync(s, token, title, markdown, type, parentExternalId, ct);
    }

    private async Task<CreatedIssue> CreateCoreAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, string type, string? parentKey, CancellationToken ct)
    {
        var fields = new Dictionary<string, object>
        {
            ["project"] = new { key = s.ProjectKey },
            ["summary"] = title,
            ["issuetype"] = new { name = type },
            ["description"] = Adf(markdown),
        };
        if (parentKey is not null)
        {
            fields["parent"] = new { key = parentKey };
        }

        using var request = Request(HttpMethod.Post, s, "/rest/api/3/issue", token, new { fields });
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
    internal static object Adf(string text) => new
    {
        type = "doc",
        version = 1,
        // Markdown images become their address: Jira can't show an image from elsewhere in an API-made issue.
        content = Blocks(text.Split('\n').Select(line => Regex.Replace(line, @"^!\[([^\]]*)\]\((https?://[^)\s]+)\)$", "$1: $2"))),
    };

    /// <summary>Paragraphs, with runs of "- " lines as bullet lists.</summary>
    private static object[] Blocks(IEnumerable<string> lines)
    {
        var blocks = new List<object>();
        List<object>? items = null;
        foreach (var line in lines)
        {
            if (line.StartsWith("- ", StringComparison.Ordinal))
            {
                if (items is null)
                {
                    items = [];
                    blocks.Add(new { type = "bulletList", content = items });
                }

                items.Add(new { type = "listItem", content = new object[] { new { type = "paragraph", content = Inline(line[2..]) } } });
                continue;
            }

            items = null;
            blocks.Add(line.Length == 0
                ? new { type = "paragraph", content = Array.Empty<object>() }
                : new { type = "paragraph", content = Inline(line) });
        }

        return [.. blocks];
    }

    private static readonly Regex Marked = new(@"\*\*(.+?)\*\*|\[([^\]]+)\]\((https?://[^)\s]+)\)|`([^`]+)`|(https?://\S*[^\s.,;:!?)])", RegexOptions.Compiled);

    /// <summary>A line's text, with **bold**, `code`, [links](…) and bare addresses as Jira marks.</summary>
    private static object[] Inline(string line)
    {
        var nodes = new List<object>();
        void Text(string value, object? mark = null)
        {
            if (value.Length > 0)
            {
                nodes.Add(mark is null ? new { type = "text", text = value } : new { type = "text", text = value, marks = new[] { mark } });
            }
        }

        var at = 0;
        foreach (Match m in Marked.Matches(line))
        {
            Text(line[at..m.Index]);
            if (m.Groups[1].Success)
            {
                Text(m.Groups[1].Value, new { type = "strong" });
            }
            else if (m.Groups[2].Success)
            {
                Text(m.Groups[2].Value, new { type = "link", attrs = new { href = m.Groups[3].Value } });
            }
            else if (m.Groups[4].Success)
            {
                Text(m.Groups[4].Value, new { type = "code" });
            }
            else
            {
                Text(m.Value, new { type = "link", attrs = new { href = m.Value } });
            }

            at = m.Index + m.Length;
        }

        Text(line[at..]);
        return [.. nodes];
    }

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

    public bool Upfront => false;

    /// <summary>An attachment on the issue.</summary>
    public async Task<string?> UploadAsync(TrackerSettings s, TrackerAuth token, string? issueExternalId, IssueFile file, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, s, $"/rest/api/3/issue/{Uri.EscapeDataString(issueExternalId!)}/attachments", token);
        request.Content = await Trackers.FileFormAsync("file", file, ct);
        request.Headers.Add("X-Atlassian-Token", "no-check");
        await Trackers.SendAsync(http, request, ct);
        return null;
    }
}
