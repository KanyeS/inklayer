using System.Globalization;
using System.Text.Json.Nodes;

namespace Inklayer.Api.Features.Issues;

/// <summary>Jira as a kanban's board: its project's statuses and issues, kept in step both ways (REST v3).</summary>
internal sealed partial class JiraTracker
{
    private const int PageSize = 100;
    private const int MaxIssues = 500;

    private static readonly string[] BoardFields =
        ["summary", "description", "status", "assignee", "duedate", "labels", "priority", "issuetype", "parent", "issuelinks", "updated"];

    /// <summary>Jira's link type names, and ours.</summary>
    private static readonly Dictionary<string, string> LinkTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Blocks"] = "blocks", ["Relates"] = "relates", ["Duplicate"] = "duplicates", ["Cloners"] = "clones",
    };

    /// <summary>Jira's status categories (new, indeterminate, done) as a kanban's column kinds.</summary>
    private static string Category(JsonNode? status) => status?["statusCategory"]?["key"]?.GetValue<string>() switch
    {
        "done" => "done",
        "indeterminate" => "doing",
        _ => "todo",
    };

    public async Task<IReadOnlyList<BoardStatus>> StatusesAsync(TrackerSettings s, TrackerAuth token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/project/{Uri.EscapeDataString(s.ProjectKey!)}/statuses", token);
        var types = (await Trackers.SendAsync(http, request, ct))?.AsArray() ?? [];
        // Each issue type lists its statuses; most share them. In the order the first type lists them, which follows the workflow.
        var statuses = new List<BoardStatus>();
        foreach (var status in types.SelectMany(t => t?["statuses"]?.AsArray() ?? []))
        {
            var id = Trackers.Id(status?["id"]);
            if (id.Length > 0 && statuses.All(x => x.Id != id))
            {
                statuses.Add(new BoardStatus(id, status!["name"]?.GetValue<string>() ?? id, Category(status)));
            }
        }

        return statuses;
    }

    public async Task<IReadOnlyList<BoardIssue>> ChangedAsync(TrackerSettings s, TrackerAuth token, int? minutes, CancellationToken ct)
    {
        var project = $"project = \"{s.ProjectKey!.Trim()}\"";
        // Relative times are in the server's clock, so the reader's time zone doesn't matter.
        var jql = minutes is { } m
            ? $"{project} AND updated >= \"-{Math.Max(1, m)}m\" ORDER BY updated ASC"
            : $"{project} AND (statusCategory != Done OR updated >= \"-30d\") ORDER BY rank ASC";
        var issues = new List<BoardIssue>();
        string? next = null;
        do
        {
            var body = new Dictionary<string, object> { ["jql"] = jql, ["fields"] = BoardFields, ["maxResults"] = PageSize };
            if (next is not null)
            {
                body["nextPageToken"] = next;
            }

            using var request = Request(HttpMethod.Post, s, "/rest/api/3/search/jql", token, body);
            var page = await Trackers.SendAsync(http, request, ct);
            issues.AddRange((page?["issues"]?.AsArray() ?? []).Select(i => BoardIssueOf(s, i!)));
            next = page?["nextPageToken"]?.GetValue<string>();
        }
        while (next is not null && issues.Count < MaxIssues);

        return issues;
    }

    private static BoardIssue BoardIssueOf(TrackerSettings s, JsonNode issue)
    {
        var key = issue["key"]!.GetValue<string>();
        var f = issue["fields"];
        var links = new List<BoardLink>();
        foreach (var link in f?["issuelinks"]?.AsArray() ?? [])
        {
            if (link?["type"]?["name"]?.GetValue<string>() is not { } name || !LinkTypes.TryGetValue(name, out var type))
            {
                continue;
            }

            if (link["outwardIssue"]?["key"]?.GetValue<string>() is { } outward)
            {
                links.Add(new BoardLink(type, outward, true));
            }
            else if (link["inwardIssue"]?["key"]?.GetValue<string>() is { } inward)
            {
                links.Add(new BoardLink(type, inward, false));
            }
        }

        var issueType = f?["issuetype"];
        var typeName = issueType?["name"]?.GetValue<string>()?.ToLowerInvariant() ?? "task";
        return new BoardIssue(
            Trackers.Id(issue["id"]), key, $"{s.Site!.TrimEnd('/')}/browse/{key}",
            f?["summary"]?.GetValue<string>() ?? "", TextFromAdf(f?["description"]),
            Trackers.Id(f?["status"]?["id"]), Category(f?["status"]),
            f?["assignee"]?["accountId"]?.GetValue<string>(), f?["assignee"]?["displayName"]?.GetValue<string>(),
            f?["duedate"]?.GetValue<string>(),
            [.. (f?["labels"]?.AsArray() ?? []).Select(l => l?.GetValue<string>()).OfType<string>()],
            f?["priority"]?["name"]?.GetValue<string>()?.ToLowerInvariant(),
            typeName is "bug" or "story" or "epic" ? typeName : "task",
            f?["parent"]?["key"]?.GetValue<string>(),
            Trackers.Time(f?["updated"]),
            links);
    }

    public async Task UpdateAsync(TrackerSettings s, TrackerAuth token, string key, BoardChange change, CancellationToken ct)
    {
        if (change.IsEmpty)
        {
            return;
        }

        var fields = new Dictionary<string, object?>();
        if (change.Title is { } title)
        {
            fields["summary"] = title;
        }

        if (change.Description is { } description)
        {
            fields["description"] = Adf(description);
        }

        if (change.SetDue)
        {
            fields["duedate"] = change.Due;
        }

        if (change.Labels is { } labels)
        {
            // Jira labels can't have spaces.
            fields["labels"] = labels.Select(l => l.Replace(' ', '-')).ToArray();
        }

        if (change.Priority is { } priority)
        {
            fields["priority"] = new { name = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(priority) };
        }

        if (change.SetAssignee)
        {
            fields["assignee"] = change.Assignee is { } id ? new { accountId = id } : null;
        }

        using var request = Request(HttpMethod.Put, s, $"/rest/api/3/issue/{Uri.EscapeDataString(key)}", token, new { fields });
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task TransitionAsync(TrackerSettings s, TrackerAuth token, string key, string statusId, CancellationToken ct)
    {
        // Already there (a new issue starts in its workflow's first status): nothing to do.
        using var get = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(key)}?fields=status", token);
        if (Trackers.Id((await Trackers.SendAsync(http, get, ct))?["fields"]?["status"]?["id"]) == statusId)
        {
            return;
        }

        using var list = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(key)}/transitions", token);
        var transitions = (await Trackers.SendAsync(http, list, ct))?["transitions"]?.AsArray() ?? [];
        var to = transitions.FirstOrDefault(t => Trackers.Id(t?["to"]?["id"]) == statusId)
            ?? throw new InvalidOperationException($"{key}'s workflow has no way to that status from where it is.");
        using var request = Request(HttpMethod.Post, s, $"/rest/api/3/issue/{Uri.EscapeDataString(key)}/transitions", token,
            new { transition = new { id = Trackers.Id(to["id"]) } });
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task LinkAsync(TrackerSettings s, TrackerAuth token, string type, string fromKey, string toKey, CancellationToken ct)
    {
        var name = LinkTypes.First(t => t.Value == type).Key;
        // Jira reads "outward blocks inward": the first issue named is the one that blocks.
        using var request = Request(HttpMethod.Post, s, "/rest/api/3/issueLink", token,
            new { type = new { name }, outwardIssue = new { key = fromKey }, inwardIssue = new { key = toKey } });
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task<string?> FindAccountAsync(TrackerSettings s, TrackerAuth token, string email, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/user/search?query={Uri.EscapeDataString(email)}&maxResults=2", token);
        var users = (await Trackers.SendAsync(http, request, ct))?.AsArray() ?? [];
        // Only a single, exact match: Jira matches names too, and an address it hides matches nothing.
        var exact = users.Where(u => string.Equals(u?["emailAddress"]?.GetValue<string>(), email, StringComparison.OrdinalIgnoreCase)).ToList();
        return exact.Count == 1 ? exact[0]?["accountId"]?.GetValue<string>() : users.Count == 1 ? users[0]?["accountId"]?.GetValue<string>() : null;
    }

    public async Task<CreatedIssue> CreateTaskAsync(TrackerSettings s, TrackerAuth token, string title, string description, string type, string? parentKey, CancellationToken ct)
    {
        if (parentKey is not null)
        {
            return await CreateUnderAsync(s, token, title, description, parentKey, ct);
        }

        // The project's own type of that name (Task, Bug, Story, Epic), else the connection's.
        var types = await IssueTypesAsync(s, token, ct);
        var wanted = types.FirstOrDefault(t => string.Equals(t, type, StringComparison.OrdinalIgnoreCase))
            ?? (s.IssueType is { Length: > 0 } fallback ? fallback : (types.Count > 0 ? types[0] : "Task"));
        return await CreateCoreAsync(s, token, title, description, wanted, null, ct);
    }
}
