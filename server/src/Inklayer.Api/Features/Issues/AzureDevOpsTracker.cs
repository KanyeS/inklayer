using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>
/// Azure DevOps Boards work items (REST 7.1), in Azure DevOps Services or Server. <see cref="TrackerSettings.Site"/> is the
/// organisation (or collection) address, <see cref="TrackerSettings.ProjectKey"/> the project, and
/// <see cref="TrackerSettings.IssueType"/> the work item type (Bug by default). Token: a personal access token with
/// Work Items: read and write. Open or closed follows the state's category: Completed and Removed count as closed.
/// </summary>
internal sealed class AzureDevOpsTracker(IHttpClientFactory http) : IIssueTracker
{
    private const string Version = "api-version=7.1";

    private static string Type(TrackerSettings s) => s.IssueType is { Length: > 0 } t ? t.Trim() : "Bug";

    private static string Project(TrackerSettings s) => $"{s.Site!.TrimEnd('/')}/{Uri.EscapeDataString(s.ProjectKey!.Trim())}";

    private static HttpRequestMessage Request(HttpMethod method, string url, string token, HttpContent? content = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = content };
        // A personal access token goes in Basic auth with an empty user name.
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($":{token}")));
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    /// <summary>Work items are changed with JSON Patch.</summary>
    private static StringContent Patch(params object[] operations) =>
        new(JsonSerializer.Serialize(operations), Encoding.UTF8, "application/json-patch+json");

    private static string WorkItemType(TrackerSettings s, string type) =>
        $"{Project(s)}/_apis/wit/workitemtypes/{Uri.EscapeDataString(type)}";

    /// <summary>Checks the project and the work item type in one call, with only the Work Items scope.</summary>
    public async Task TestAsync(TrackerSettings s, string token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{WorkItemType(s, Type(s))}?{Version}", token);
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, string token, string title, string markdown, CancellationToken ct)
    {
        var type = Type(s);
        // Bugs show Repro Steps on their form instead of Description. Both fields take HTML.
        var field = type.Equals("Bug", StringComparison.OrdinalIgnoreCase) ? "Microsoft.VSTS.TCM.ReproSteps" : "System.Description";
        var html = Trackers.HtmlFromText(markdown);
        using var request = Request(HttpMethod.Post, $"{Project(s)}/_apis/wit/workitems/${Uri.EscapeDataString(type)}?{Version}", token, Patch(
            new { op = "add", path = "/fields/System.Title", value = title },
            new { op = "add", path = $"/fields/{field}", value = html }));
        var item = await Trackers.SendAsync(http, request, ct);
        var id = item!["id"]!.GetValue<int>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        var url = item["_links"]?["html"]?["href"]?.GetValue<string>() ?? $"{Project(s)}/_workitems/edit/{id}";
        return new CreatedIssue(id, $"#{id}", url);
    }

    public async Task<string> StateAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        var (type, state) = await CurrentAsync(s, token, externalId, ct);
        var category = (await StatesAsync(s, token, type, ct)).FirstOrDefault(st => st.Name.Equals(state, StringComparison.OrdinalIgnoreCase)).Category;
        return category is "Completed" or "Removed" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        var (type, _) = await CurrentAsync(s, token, externalId, ct);
        var done = (await StatesAsync(s, token, type, ct)).FirstOrDefault(st => st.Category == "Completed").Name is { Length: > 0 } name
            ? name
            : throw new InvalidOperationException($"The work item type {type} has no Completed state.");
        using var request = Request(HttpMethod.Patch, $"{Project(s)}/_apis/wit/workitems/{Uri.EscapeDataString(externalId)}?{Version}", token,
            Patch(new { op = "add", path = "/fields/System.State", value = done }));
        await Trackers.SendAsync(http, request, ct);
    }

    /// <summary>The work item's own type (it may have been changed since) and its state.</summary>
    private async Task<(string Type, string State)> CurrentAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get,
            $"{Project(s)}/_apis/wit/workitems/{Uri.EscapeDataString(externalId)}?fields=System.WorkItemType,System.State&{Version}", token);
        var fields = (await Trackers.SendAsync(http, request, ct))?["fields"];
        return (fields?["System.WorkItemType"]?.GetValue<string>() ?? Type(s), fields?["System.State"]?.GetValue<string>() ?? "");
    }

    /// <summary>The type's states with their categories (Proposed, InProgress, Resolved, Completed, Removed).</summary>
    private async Task<List<(string Name, string Category)>> StatesAsync(TrackerSettings s, string token, string type, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{WorkItemType(s, type)}/states?{Version}", token);
        var states = (await Trackers.SendAsync(http, request, ct))?["value"]?.AsArray() ?? [];
        return states.Select(st => (st?["name"]?.GetValue<string>() ?? "", st?["category"]?.GetValue<string>() ?? "")).ToList();
    }

    private const string CommentsVersion = "api-version=7.1-preview.4";

    private static string ItemUrl(TrackerSettings s, string id) => $"{Project(s)}/_workitems/edit/{id}";

    public async Task<FoundIssue> GetAsync(TrackerSettings s, string token, string reference, CancellationToken ct)
    {
        var text = reference.Trim();
        var match = Regex.Match(text, @"^#?(\d{1,12})$");
        if (!match.Success && Uri.TryCreate(text, UriKind.Absolute, out var uri))
        {
            // https://dev.azure.com/acme/Web%20Shop/_workitems/edit/12, with or without the project.
            match = Regex.Match(uri.AbsolutePath, @"/_workitems/edit/(\d{1,12})(?:/|$)", RegexOptions.IgnoreCase);
        }

        if (!match.Success)
        {
            throw new InvalidOperationException("Give the work item's number, such as #12, or its address.");
        }

        var id = match.Groups[1].Value;
        using var request = Request(HttpMethod.Get,
            $"{Project(s)}/_apis/wit/workitems/{id}?fields=System.Title,System.State,System.WorkItemType,System.TeamProject&{Version}", token);
        var fields = (await Trackers.SendAsync(http, request, ct))?["fields"];
        if (!string.Equals(fields?["System.TeamProject"]?.GetValue<string>(), s.ProjectKey!.Trim(), StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Work item {id} isn't in the {s.ProjectKey!.Trim()} project.");
        }

        var type = fields?["System.WorkItemType"]?.GetValue<string>() ?? Type(s);
        var state = fields?["System.State"]?.GetValue<string>() ?? "";
        var category = (await StatesAsync(s, token, type, ct)).FirstOrDefault(st => st.Name.Equals(state, StringComparison.OrdinalIgnoreCase)).Category;
        return new FoundIssue(id, $"#{id}", fields?["System.Title"]?.GetValue<string>() ?? "", ItemUrl(s, id),
            category is "Completed" or "Removed" ? IssueStates.Closed : IssueStates.Open);
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchAsync(TrackerSettings s, string token, string query, CancellationToken ct)
    {
        // WIQL can't ask for state categories; these are the finished states of the standard processes.
        var words = query.Trim().Replace("'", "''", StringComparison.Ordinal);
        var wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed')"
            + (words.Length > 0 ? $" AND [System.Title] CONTAINS '{words}'" : "") + " ORDER BY [System.ChangedDate] DESC";
        using var request = Request(HttpMethod.Post, $"{Project(s)}/_apis/wit/wiql?$top=10&{Version}", token, Trackers.Json(new { query = wiql }, "application/json"));
        var ids = ((await Trackers.SendAsync(http, request, ct))?["workItems"]?.AsArray() ?? []).Select(w => Trackers.Id(w!["id"])).ToList();
        if (ids.Count == 0)
        {
            return [];
        }

        using var details = Request(HttpMethod.Get, $"{Project(s)}/_apis/wit/workitems?ids={string.Join(',', ids)}&fields=System.Title&{Version}", token);
        var items = (await Trackers.SendAsync(http, details, ct))?["value"]?.AsArray() ?? [];
        return [.. items.Select(i =>
        {
            var id = Trackers.Id(i!["id"]);
            return new FoundIssue(id, $"#{id}", i["fields"]?["System.Title"]?.GetValue<string>() ?? "", ItemUrl(s, id), IssueStates.Open);
        })];
    }

    public async Task<IReadOnlyList<TrackerComment>> CommentsAsync(TrackerSettings s, string token, string externalId, DateTime? since, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Project(s)}/_apis/wit/workItems/{Uri.EscapeDataString(externalId)}/comments?$top=100&{CommentsVersion}", token);
        var comments = (await Trackers.SendAsync(http, request, ct))?["comments"]?.AsArray() ?? [];
        return Trackers.After(comments.Select(c => new TrackerComment(
            Trackers.Id(c!["id"]), c["createdBy"]?["displayName"]?.GetValue<string>() ?? "Azure DevOps", null,
            Trackers.TextFromHtml(c["text"]?.GetValue<string>() ?? ""), Trackers.Time(c["createdDate"]), Trackers.Time(c["modifiedDate"] ?? c["createdDate"]))), since);
    }

    public async Task<string> AddCommentAsync(TrackerSettings s, string token, string externalId, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Project(s)}/_apis/wit/workItems/{Uri.EscapeDataString(externalId)}/comments?{CommentsVersion}", token,
            Trackers.Json(new { text = Trackers.HtmlFromText(markdown) }, "application/json"));
        return Trackers.Id((await Trackers.SendAsync(http, request, ct))?["id"]);
    }
}
