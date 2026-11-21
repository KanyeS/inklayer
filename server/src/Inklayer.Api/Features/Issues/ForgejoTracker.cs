using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>
/// Forgejo and Gitea issues (REST v1): Codeberg by default, or a self-hosted instance (<see cref="TrackerSettings.Site"/>).
/// Token: an access token with the <c>issue</c> scope (read and write) and <c>repository</c> (read).
/// </summary>
internal sealed class ForgejoTracker(IHttpClientFactory http) : IIssueTracker, IPullRequests, IIssueFiles
{
    private static string Repo(TrackerSettings s) =>
        $"{(s.Site is { Length: > 0 } site ? site : "https://codeberg.org").TrimEnd('/')}/api/v1/repos/{Uri.EscapeDataString(s.Owner!.Trim())}/{Uri.EscapeDataString(s.Repo!.Trim())}";

    private static HttpRequestMessage Request(HttpMethod method, string url, TrackerAuth token, object? body = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = body is null ? null : Trackers.Json(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue(token.OAuth ? "Bearer" : "token", token.Token);
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    public async Task TestAsync(TrackerSettings s, TrackerAuth token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, Repo(s), token);
        var repo = await Trackers.SendAsync(http, request, ct);
        if (repo?["has_issues"]?.GetValue<bool>() == false)
        {
            throw new InvalidOperationException("Issues are turned off for this repository (Settings → Units).");
        }
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues", token, new { title, body = markdown });
        var issue = await Trackers.SendAsync(http, request, ct);
        var number = issue!["number"]!.GetValue<long>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new CreatedIssue(number, $"#{number}", issue["html_url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue!["state"]!.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Patch, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}", token, new { state = "closed" });
        await Trackers.SendAsync(http, request, ct);
    }

    private static FoundIssue Found(JsonNode issue) => new(
        Trackers.Id(issue["number"]), $"#{Trackers.Id(issue["number"])}", issue["title"]?.GetValue<string>() ?? "", issue["html_url"]!.GetValue<string>(),
        issue["state"]?.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open);

    public async Task<FoundIssue> GetAsync(TrackerSettings s, TrackerAuth token, string reference, CancellationToken ct)
    {
        var number = Trackers.IssueNumber(reference, Regex.Escape($"{Trackers.SitePath(s.Site)}/{s.Owner}/{s.Repo}") + "/issues", $"{s.Owner}/{s.Repo}");
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{number}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue?["pull_request"] is null or JsonValue ? Found(issue!) : throw new InvalidOperationException($"#{number} is a pull request, not an issue.");
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchAsync(TrackerSettings s, TrackerAuth token, string query, CancellationToken ct)
    {
        var q = query.Trim().Length > 0 ? $"&q={Uri.EscapeDataString(query.Trim())}" : "";
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues?state=open&type=issues&limit=10{q}", token);
        var issues = (await Trackers.SendAsync(http, request, ct))?.AsArray() ?? [];
        return [.. issues.Select(i => Found(i!))];
    }

    public async Task<IReadOnlyList<TrackerComment>> CommentsAsync(TrackerSettings s, TrackerAuth token, string externalId, DateTime? since, CancellationToken ct)
    {
        var after = since is { } t ? $"?since={Trackers.Iso(t)}" : "";
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}/comments{after}", token);
        var comments = (await Trackers.SendAsync(http, request, ct))?.AsArray() ?? [];
        return Trackers.After(comments.Select(c => new TrackerComment(
            Trackers.Id(c!["id"]),
            c["user"]?["full_name"]?.GetValue<string>() is { Length: > 0 } name ? name : c["user"]?["login"]?.GetValue<string>() ?? "Forgejo",
            c["user"]?["html_url"]?.GetValue<string>(), c["body"]?.GetValue<string>() ?? "", Trackers.Time(c["created_at"]), Trackers.Time(c["updated_at"]))), since);
    }

    public async Task<string> AddCommentAsync(TrackerSettings s, TrackerAuth token, string externalId, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}/comments", token, new { body = markdown });
        return Trackers.Id((await Trackers.SendAsync(http, request, ct))?["id"]);
    }

    /// <summary>A pull request, from the pulls API (<c>merged</c>) or the issues list (<c>pull_request.merged</c>).</summary>
    private static FoundIssue FoundPull(JsonNode pr)
    {
        var number = Trackers.Id(pr["number"]);
        var merged = pr["merged"] is JsonValue m && m.TryGetValue<bool>(out var yes) && yes
            || pr["pull_request"]?["merged"] is JsonValue n && n.TryGetValue<bool>(out var also) && also;
        return new FoundIssue(number, $"PR #{number}", pr["title"]?.GetValue<string>() ?? "", pr["html_url"]!.GetValue<string>(),
            merged ? IssueStates.Merged : pr["state"]?.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open);
    }

    public async Task<FoundIssue> GetPullRequestAsync(TrackerSettings s, TrackerAuth token, string reference, CancellationToken ct)
    {
        var number = Trackers.IssueNumber(reference, Regex.Escape($"{Trackers.SitePath(s.Site)}/{s.Owner}/{s.Repo}") + "/pulls", $"{s.Owner}/{s.Repo}", "pull request");
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/pulls/{number}", token);
        return FoundPull((await Trackers.SendAsync(http, request, ct))!);
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchPullRequestsAsync(TrackerSettings s, TrackerAuth token, string query, CancellationToken ct)
    {
        var q = query.Trim().Length > 0 ? $"&q={Uri.EscapeDataString(query.Trim())}" : "";
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues?state=open&type=pulls&limit=10{q}", token);
        return [.. ((await Trackers.SendAsync(http, request, ct))?.AsArray() ?? []).Select(p => FoundPull(p!))];
    }

    public async Task<string> PullRequestStateAsync(TrackerSettings s, TrackerAuth token, string number, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/pulls/{Uri.EscapeDataString(number)}", token);
        return FoundPull((await Trackers.SendAsync(http, request, ct))!).State;
    }

    public async Task<string> AddPullRequestCommentAsync(TrackerSettings s, TrackerAuth token, string number, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues/{Uri.EscapeDataString(number)}/comments", token, new { body = markdown });
        return Trackers.Id((await Trackers.SendAsync(http, request, ct))?["id"]);
    }

    public async Task EditPullRequestCommentAsync(TrackerSettings s, TrackerAuth token, string number, string commentId, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Patch, $"{Repo(s)}/issues/comments/{Uri.EscapeDataString(commentId)}", token, new { body = markdown });
        await Trackers.SendAsync(http, request, ct);
    }

    public bool Upfront => false;

    /// <summary>An attachment on the issue.</summary>
    public async Task<string?> UploadAsync(TrackerSettings s, TrackerAuth token, string? issueExternalId, IssueFile file, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues/{Uri.EscapeDataString(issueExternalId!)}/assets?name={Uri.EscapeDataString(file.FileName)}", token);
        request.Content = Trackers.FileForm("attachment", file);
        await Trackers.SendAsync(http, request, ct);
        return null;
    }
}
