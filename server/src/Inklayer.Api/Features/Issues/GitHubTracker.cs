using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>GitHub Issues (REST). Token: a fine-grained token with Issues read and write on the repository.</summary>
internal sealed class GitHubTracker(IHttpClientFactory http) : IIssueTracker
{
    private static string Api(TrackerSettings s) => (s.ApiUrl is { Length: > 0 } url ? url : "https://api.github.com").TrimEnd('/');

    private static HttpRequestMessage Request(HttpMethod method, string url, TrackerAuth token, object? body = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = body is null ? null : Trackers.Json(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.Token);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.UserAgent.ParseAdd("Inklayer");
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        return request;
    }

    private static string Repo(TrackerSettings s) => $"{Api(s)}/repos/{Uri.EscapeDataString(s.Owner!)}/{Uri.EscapeDataString(s.Repo!)}";

    public async Task TestAsync(TrackerSettings s, TrackerAuth token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, Repo(s), token);
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues", token, new { title, body = markdown });
        var issue = await Trackers.SendAsync(http, request, ct);
        var number = issue!["number"]!.GetValue<int>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new CreatedIssue(number, $"#{number}", issue["html_url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{externalId}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue!["state"]!.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Patch, $"{Repo(s)}/issues/{externalId}", token, new { state = "closed", state_reason = "completed" });
        await Trackers.SendAsync(http, request, ct);
    }

    private static FoundIssue Found(JsonNode issue) => new(
        Trackers.Id(issue["number"]), $"#{Trackers.Id(issue["number"])}", issue["title"]?.GetValue<string>() ?? "", issue["html_url"]!.GetValue<string>(),
        issue["state"]?.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open);

    public async Task<FoundIssue> GetAsync(TrackerSettings s, TrackerAuth token, string reference, CancellationToken ct)
    {
        var number = Trackers.IssueNumber(reference, Regex.Escape($"/{s.Owner}/{s.Repo}") + "/issues", $"{s.Owner}/{s.Repo}");
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{number}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue?["pull_request"] is null ? Found(issue!) : throw new InvalidOperationException($"#{number} is a pull request, not an issue.");
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchAsync(TrackerSettings s, TrackerAuth token, string query, CancellationToken ct)
    {
        if (query.Trim().Length == 0)
        {
            // The issues list includes pull requests; ask for more and keep the issues.
            using var list = Request(HttpMethod.Get, $"{Repo(s)}/issues?state=open&sort=updated&per_page=30", token);
            var all = (await Trackers.SendAsync(http, list, ct))?.AsArray() ?? [];
            return [.. all.Where(i => i?["pull_request"] is null).Take(10).Select(i => Found(i!))];
        }

        var q = Uri.EscapeDataString($"repo:{s.Owner}/{s.Repo} is:issue is:open in:title {query.Trim()}");
        using var request = Request(HttpMethod.Get, $"{Api(s)}/search/issues?q={q}&sort=updated&per_page=10", token);
        var items = (await Trackers.SendAsync(http, request, ct))?["items"]?.AsArray() ?? [];
        return [.. items.Select(i => Found(i!))];
    }

    public async Task<IReadOnlyList<TrackerComment>> CommentsAsync(TrackerSettings s, TrackerAuth token, string externalId, DateTime? since, CancellationToken ct)
    {
        var after = since is { } t ? $"&since={Trackers.Iso(t)}" : "";
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}/comments?per_page=100{after}", token);
        var comments = (await Trackers.SendAsync(http, request, ct))?.AsArray() ?? [];
        return Trackers.After(comments.Select(c => new TrackerComment(
            Trackers.Id(c!["id"]), c["user"]?["login"]?.GetValue<string>() ?? "GitHub", c["user"]?["html_url"]?.GetValue<string>(),
            c["body"]?.GetValue<string>() ?? "", Trackers.Time(c["created_at"]), Trackers.Time(c["updated_at"]))), since);
    }

    public async Task<string> AddCommentAsync(TrackerSettings s, TrackerAuth token, string externalId, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}/comments", token, new { body = markdown });
        return Trackers.Id((await Trackers.SendAsync(http, request, ct))?["id"]);
    }
}
