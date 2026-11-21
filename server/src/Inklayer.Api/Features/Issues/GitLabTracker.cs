using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>
/// GitLab issues (REST v4), on gitlab.com or a self-managed instance (<see cref="TrackerSettings.Site"/>).
/// <see cref="TrackerSettings.ProjectKey"/> is the project's path, such as <c>group/subgroup/project</c>. Token: a personal,
/// project or group access token with the <c>api</c> scope, from someone with at least the Reporter role.
/// </summary>
internal sealed class GitLabTracker(IHttpClientFactory http) : IIssueTracker, IPullRequests
{
    private static string Project(TrackerSettings s) =>
        $"{(s.Site is { Length: > 0 } site ? site : "https://gitlab.com").TrimEnd('/')}/api/v4/projects/{Uri.EscapeDataString(s.ProjectKey!.Trim().Trim('/'))}";

    private static HttpRequestMessage Request(HttpMethod method, string url, TrackerAuth token, object? body = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = body is null ? null : Trackers.Json(body) };
        if (token.OAuth)
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        }
        else
        {
            request.Headers.Add("PRIVATE-TOKEN", token.Token);
        }

        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    public async Task TestAsync(TrackerSettings s, TrackerAuth token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, Project(s), token);
        var project = await Trackers.SendAsync(http, request, ct);
        if (project?["issues_enabled"]?.GetValue<bool>() == false)
        {
            throw new InvalidOperationException("Issues are turned off for this project (Settings → General → Visibility, project features, permissions).");
        }
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Project(s)}/issues", token, new { title, description = markdown });
        var issue = await Trackers.SendAsync(http, request, ct);
        // The iid is the number people see (#12); the global id isn't used in project URLs.
        var iid = issue!["iid"]!.GetValue<int>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new CreatedIssue(iid, $"#{iid}", issue["web_url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Project(s)}/issues/{Uri.EscapeDataString(externalId)}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue!["state"]!.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Put, $"{Project(s)}/issues/{Uri.EscapeDataString(externalId)}", token, new { state_event = "close" });
        await Trackers.SendAsync(http, request, ct);
    }

    private static FoundIssue Found(JsonNode issue) => new(
        Trackers.Id(issue["iid"]), $"#{Trackers.Id(issue["iid"])}", issue["title"]?.GetValue<string>() ?? "", issue["web_url"]!.GetValue<string>(),
        issue["state"]?.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open);

    public async Task<FoundIssue> GetAsync(TrackerSettings s, TrackerAuth token, string reference, CancellationToken ct)
    {
        var path = s.ProjectKey!.Trim().Trim('/');
        var iid = Trackers.IssueNumber(reference, Regex.Escape($"{Trackers.SitePath(s.Site)}/{path}") + "(?:/-)?/issues", path);
        using var request = Request(HttpMethod.Get, $"{Project(s)}/issues/{iid}", token);
        return Found((await Trackers.SendAsync(http, request, ct))!);
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchAsync(TrackerSettings s, TrackerAuth token, string query, CancellationToken ct)
    {
        var q = query.Trim().Length > 0 ? $"&search={Uri.EscapeDataString(query.Trim())}&in=title" : "";
        using var request = Request(HttpMethod.Get, $"{Project(s)}/issues?state=opened&order_by=updated_at&per_page=10{q}", token);
        var issues = (await Trackers.SendAsync(http, request, ct))?.AsArray() ?? [];
        return [.. issues.Select(i => Found(i!))];
    }

    public async Task<IReadOnlyList<TrackerComment>> CommentsAsync(TrackerSettings s, TrackerAuth token, string externalId, DateTime? since, CancellationToken ct)
    {
        // Notes include system ones ("changed the description", "closed"); only people's comments are wanted.
        using var request = Request(HttpMethod.Get, $"{Project(s)}/issues/{Uri.EscapeDataString(externalId)}/notes?sort=desc&order_by=updated_at&per_page=100", token);
        var notes = (await Trackers.SendAsync(http, request, ct))?.AsArray() ?? [];
        return Trackers.After(notes.Where(n => n?["system"]?.GetValue<bool>() != true).Select(n => new TrackerComment(
            Trackers.Id(n!["id"]), n["author"]?["name"]?.GetValue<string>() ?? "GitLab", n["author"]?["web_url"]?.GetValue<string>(),
            n["body"]?.GetValue<string>() ?? "", Trackers.Time(n["created_at"]), Trackers.Time(n["updated_at"]))), since);
    }

    public async Task<string> AddCommentAsync(TrackerSettings s, TrackerAuth token, string externalId, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Project(s)}/issues/{Uri.EscapeDataString(externalId)}/notes", token, new { body = markdown });
        return Trackers.Id((await Trackers.SendAsync(http, request, ct))?["id"]);
    }

    /// <summary>A merge request: opened, merged, or closed (and locked, which is closing).</summary>
    private static FoundIssue FoundMerge(JsonNode mr)
    {
        var iid = Trackers.Id(mr["iid"]);
        var state = mr["state"]?.GetValue<string>() switch
        {
            "merged" => IssueStates.Merged,
            "opened" => IssueStates.Open,
            _ => IssueStates.Closed,
        };
        return new FoundIssue(iid, $"!{iid}", mr["title"]?.GetValue<string>() ?? "", mr["web_url"]!.GetValue<string>(), state);
    }

    public async Task<FoundIssue> GetPullRequestAsync(TrackerSettings s, TrackerAuth token, string reference, CancellationToken ct)
    {
        var path = s.ProjectKey!.Trim().Trim('/');
        var iid = Trackers.IssueNumber(reference, Regex.Escape($"{Trackers.SitePath(s.Site)}/{path}") + "(?:/-)?/merge_requests", path, "merge request");
        using var request = Request(HttpMethod.Get, $"{Project(s)}/merge_requests/{iid}", token);
        return FoundMerge((await Trackers.SendAsync(http, request, ct))!);
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchPullRequestsAsync(TrackerSettings s, TrackerAuth token, string query, CancellationToken ct)
    {
        var q = query.Trim().Length > 0 ? $"&search={Uri.EscapeDataString(query.Trim())}&in=title" : "";
        using var request = Request(HttpMethod.Get, $"{Project(s)}/merge_requests?state=opened&order_by=updated_at&per_page=10{q}", token);
        return [.. ((await Trackers.SendAsync(http, request, ct))?.AsArray() ?? []).Select(m => FoundMerge(m!))];
    }

    public async Task<string> PullRequestStateAsync(TrackerSettings s, TrackerAuth token, string number, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Project(s)}/merge_requests/{Uri.EscapeDataString(number)}", token);
        return FoundMerge((await Trackers.SendAsync(http, request, ct))!).State;
    }

    public async Task<string> AddPullRequestCommentAsync(TrackerSettings s, TrackerAuth token, string number, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Project(s)}/merge_requests/{Uri.EscapeDataString(number)}/notes", token, new { body = markdown });
        return Trackers.Id((await Trackers.SendAsync(http, request, ct))?["id"]);
    }

    public async Task EditPullRequestCommentAsync(TrackerSettings s, TrackerAuth token, string number, string commentId, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Put, $"{Project(s)}/merge_requests/{Uri.EscapeDataString(number)}/notes/{Uri.EscapeDataString(commentId)}", token,
            new { body = markdown });
        await Trackers.SendAsync(http, request, ct);
    }
}
