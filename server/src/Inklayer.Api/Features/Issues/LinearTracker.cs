using System.Net.Http.Headers;
using System.Text.Json.Nodes;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Text;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>Linear (GraphQL). Token: a personal API key with write access to the team.</summary>
internal sealed class LinearTracker(IHttpClientFactory http) : IIssueTracker
{
    private const string Api = "https://api.linear.app/graphql";

    private async Task<JsonNode> QueryAsync(TrackerAuth token, string query, object variables, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Api) { Content = Trackers.Json(new { query, variables }) };
        // An API key goes in as it is; an OAuth token as a bearer token.
        request.Headers.TryAddWithoutValidation("Authorization", token.OAuth ? $"Bearer {token.Token}" : token.Token);
        var result = await Trackers.SendAsync(http, request, ct);
        if (result?["errors"] is JsonArray { Count: > 0 } errors)
        {
            throw new InvalidOperationException($"Linear: {errors[0]?["message"]?.GetValue<string>()}");
        }

        return result!["data"]!;
    }

    public Task TestAsync(TrackerSettings s, TrackerAuth token, CancellationToken ct) =>
        QueryAsync(token, "query($id: String!) { team(id: $id) { id name } }", new { id = s.TeamId }, ct);

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, TrackerAuth token, string title, string markdown, CancellationToken ct)
    {
        var data = await QueryAsync(token,
            "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
            new { input = new { teamId = s.TeamId, title, description = markdown } }, ct);
        var issue = data["issueCreate"]!["issue"]!;
        return new CreatedIssue(issue["id"]!.GetValue<string>(), issue["identifier"]!.GetValue<string>(), issue["url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        var data = await QueryAsync(token, "query($id: String!) { issue(id: $id) { state { type } } }", new { id = externalId }, ct);
        return data["issue"]?["state"]?["type"]?.GetValue<string>() is "completed" or "canceled" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, TrackerAuth token, string externalId, CancellationToken ct)
    {
        var team = await QueryAsync(token, "query($id: String!) { team(id: $id) { states { nodes { id type } } } }", new { id = s.TeamId }, ct);
        var done = team["team"]?["states"]?["nodes"]?.AsArray().FirstOrDefault(n => n?["type"]?.GetValue<string>() == "completed")
            ?? throw new InvalidOperationException("The Linear team has no completed state.");
        await QueryAsync(token, "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
            new { id = externalId, input = new { stateId = done["id"]!.GetValue<string>() } }, ct);
    }

    private const string IssueFields = "id identifier title url state { type } team { id }";

    private static FoundIssue Found(JsonNode issue) => new(
        issue["id"]!.GetValue<string>(), issue["identifier"]!.GetValue<string>(), issue["title"]?.GetValue<string>() ?? "", issue["url"]!.GetValue<string>(),
        issue["state"]?["type"]?.GetValue<string>() is "completed" or "canceled" ? IssueStates.Closed : IssueStates.Open);

    public async Task<FoundIssue> GetAsync(TrackerSettings s, TrackerAuth token, string reference, CancellationToken ct)
    {
        var text = reference.Trim();
        string id;
        if (Regex.Match(text, @"^#?(\d{1,12})$") is { Success: true } number)
        {
            var team = await QueryAsync(token, "query($id: String!) { team(id: $id) { key } }", new { id = s.TeamId }, ct);
            id = $"{team["team"]?["key"]?.GetValue<string>()}-{number.Groups[1].Value}";
        }
        else if (Regex.Match(text, @"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d{1,12})(?![A-Za-z0-9])") is { Success: true } identifier)
        {
            // ENG-5, or linear.app/acme/issue/ENG-5/some-title.
            id = identifier.Groups[1].Value.ToUpperInvariant();
        }
        else
        {
            throw new InvalidOperationException("Give the issue's identifier, such as ENG-5, or its address.");
        }

        var data = await QueryAsync(token, $"query($id: String!) {{ issue(id: $id) {{ {IssueFields} }} }}", new { id }, ct);
        var issue = data["issue"] ?? throw new InvalidOperationException($"Linear has no issue {id}.");
        return issue["team"]?["id"]?.GetValue<string>() == s.TeamId ? Found(issue) : throw new InvalidOperationException($"{id} isn't in this connection's Linear team.");
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchAsync(TrackerSettings s, TrackerAuth token, string query, CancellationToken ct)
    {
        var filter = new Dictionary<string, object>
        {
            ["team"] = new { id = new { eq = s.TeamId } },
            ["state"] = new { type = new { nin = new[] { "completed", "canceled" } } },
        };
        if (query.Trim().Length > 0)
        {
            filter["title"] = new { containsIgnoreCase = query.Trim() };
        }

        var data = await QueryAsync(token,
            $"query($filter: IssueFilter) {{ issues(first: 10, orderBy: updatedAt, filter: $filter) {{ nodes {{ {IssueFields} }} }} }}", new { filter }, ct);
        return [.. (data["issues"]?["nodes"]?.AsArray() ?? []).Select(i => Found(i!))];
    }

    public async Task<IReadOnlyList<TrackerComment>> CommentsAsync(TrackerSettings s, TrackerAuth token, string externalId, DateTime? since, CancellationToken ct)
    {
        var data = await QueryAsync(token,
            "query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { id body createdAt updatedAt user { name url } } } } }", new { id = externalId }, ct);
        var comments = data["issue"]?["comments"]?["nodes"]?.AsArray() ?? [];
        return Trackers.After(comments.Select(c => new TrackerComment(
            c!["id"]!.GetValue<string>(), c["user"]?["name"]?.GetValue<string>() ?? "Linear", c["user"]?["url"]?.GetValue<string>(),
            c["body"]?.GetValue<string>() ?? "", Trackers.Time(c["createdAt"]), Trackers.Time(c["updatedAt"]))), since);
    }

    public async Task<string> AddCommentAsync(TrackerSettings s, TrackerAuth token, string externalId, string markdown, CancellationToken ct)
    {
        var data = await QueryAsync(token, "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
            new { input = new { issueId = externalId, body = markdown } }, ct);
        return data["commentCreate"]?["comment"]?["id"]?.GetValue<string>() ?? throw new InvalidOperationException("Linear didn't add the comment.");
    }
}
