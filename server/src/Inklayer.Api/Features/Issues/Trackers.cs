using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Inklayer.Domain.Issues;

namespace Inklayer.Api.Features.Issues;

/// <summary>The non-secret settings of a tracker connection.</summary>
public sealed record TrackerSettings(string? Owner = null, string? Repo = null, string? ApiUrl = null,
    string? Site = null, string? ProjectKey = null, string? IssueType = null, string? Email = null, string? TeamId = null);

public sealed record CreatedIssue(string ExternalId, string Key, string Url);

/// <summary>Talks to one issue tracker. Methods throw with a readable message when the tracker refuses.</summary>
internal interface IIssueTracker
{
    Task TestAsync(TrackerSettings settings, string token, CancellationToken ct);

    Task<CreatedIssue> CreateAsync(TrackerSettings settings, string token, string title, string markdown, CancellationToken ct);

    /// <summary><see cref="IssueStates.Open"/> or <see cref="IssueStates.Closed"/>.</summary>
    Task<string> StateAsync(TrackerSettings settings, string token, string externalId, CancellationToken ct);

    Task CloseAsync(TrackerSettings settings, string token, string externalId, CancellationToken ct);
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
}

/// <summary>GitHub Issues (REST). Token: a fine-grained token with Issues read and write on the repository.</summary>
internal sealed class GitHubTracker(IHttpClientFactory http) : IIssueTracker
{
    private static string Api(TrackerSettings s) => (s.ApiUrl is { Length: > 0 } url ? url : "https://api.github.com").TrimEnd('/');

    private static HttpRequestMessage Request(HttpMethod method, string url, string token, object? body = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = body is null ? null : Trackers.Json(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.ParseAdd("application/vnd.github+json");
        request.Headers.UserAgent.ParseAdd("Inklayer");
        request.Headers.Add("X-GitHub-Api-Version", "2022-11-28");
        return request;
    }

    private static string Repo(TrackerSettings s) => $"{Api(s)}/repos/{Uri.EscapeDataString(s.Owner!)}/{Uri.EscapeDataString(s.Repo!)}";

    public async Task TestAsync(TrackerSettings s, string token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, Repo(s), token);
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, string token, string title, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues", token, new { title, body = markdown });
        var issue = await Trackers.SendAsync(http, request, ct);
        var number = issue!["number"]!.GetValue<int>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new CreatedIssue(number, $"#{number}", issue["html_url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{externalId}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue!["state"]!.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Patch, $"{Repo(s)}/issues/{externalId}", token, new { state = "closed", state_reason = "completed" });
        await Trackers.SendAsync(http, request, ct);
    }
}

/// <summary>Jira Cloud (REST v3). Token: an Atlassian API token for <see cref="TrackerSettings.Email"/>.</summary>
internal sealed class JiraTracker(IHttpClientFactory http) : IIssueTracker
{
    private static HttpRequestMessage Request(HttpMethod method, TrackerSettings s, string path, string token, object? body = null)
    {
        var request = new HttpRequestMessage(method, $"{s.Site!.TrimEnd('/')}{path}") { Content = body is null ? null : Trackers.Json(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{s.Email}:{token}")));
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    public async Task TestAsync(TrackerSettings s, string token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/project/{Uri.EscapeDataString(s.ProjectKey!)}", token);
        await Trackers.SendAsync(http, request, ct);
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, string token, string title, string markdown, CancellationToken ct)
    {
        // Jira wants Atlassian Document Format: one paragraph per line is enough for a bug report.
        var paragraphs = markdown.Split('\n').Select(line => line.Length == 0
            ? (object)new { type = "paragraph", content = Array.Empty<object>() }
            : new { type = "paragraph", content = new object[] { new { type = "text", text = line } } }).ToArray();
        var body = new
        {
            fields = new
            {
                project = new { key = s.ProjectKey },
                summary = title,
                issuetype = new { name = s.IssueType is { Length: > 0 } t ? t : "Bug" },
                description = new { type = "doc", version = 1, content = paragraphs },
            },
        };
        using var request = Request(HttpMethod.Post, s, "/rest/api/3/issue", token, body);
        var issue = await Trackers.SendAsync(http, request, ct);
        var key = issue!["key"]!.GetValue<string>();
        return new CreatedIssue(key, key, $"{s.Site!.TrimEnd('/')}/browse/{key}");
    }

    public async Task<string> StateAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, s, $"/rest/api/3/issue/{Uri.EscapeDataString(externalId)}?fields=status", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue?["fields"]?["status"]?["statusCategory"]?["key"]?.GetValue<string>() == "done" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
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
}

/// <summary>Linear (GraphQL). Token: a personal API key with write access to the team.</summary>
internal sealed class LinearTracker(IHttpClientFactory http) : IIssueTracker
{
    private const string Api = "https://api.linear.app/graphql";

    private async Task<JsonNode> QueryAsync(string token, string query, object variables, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, Api) { Content = Trackers.Json(new { query, variables }) };
        request.Headers.TryAddWithoutValidation("Authorization", token);
        var result = await Trackers.SendAsync(http, request, ct);
        if (result?["errors"] is JsonArray { Count: > 0 } errors)
        {
            throw new InvalidOperationException($"Linear: {errors[0]?["message"]?.GetValue<string>()}");
        }

        return result!["data"]!;
    }

    public Task TestAsync(TrackerSettings s, string token, CancellationToken ct) =>
        QueryAsync(token, "query($id: String!) { team(id: $id) { id name } }", new { id = s.TeamId }, ct);

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, string token, string title, string markdown, CancellationToken ct)
    {
        var data = await QueryAsync(token,
            "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
            new { input = new { teamId = s.TeamId, title, description = markdown } }, ct);
        var issue = data["issueCreate"]!["issue"]!;
        return new CreatedIssue(issue["id"]!.GetValue<string>(), issue["identifier"]!.GetValue<string>(), issue["url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        var data = await QueryAsync(token, "query($id: String!) { issue(id: $id) { state { type } } }", new { id = externalId }, ct);
        return data["issue"]?["state"]?["type"]?.GetValue<string>() is "completed" or "canceled" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        var team = await QueryAsync(token, "query($id: String!) { team(id: $id) { states { nodes { id type } } } }", new { id = s.TeamId }, ct);
        var done = team["team"]?["states"]?["nodes"]?.AsArray().FirstOrDefault(n => n?["type"]?.GetValue<string>() == "completed")
            ?? throw new InvalidOperationException("The Linear team has no completed state.");
        await QueryAsync(token, "mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }",
            new { id = externalId, input = new { stateId = done["id"]!.GetValue<string>() } }, ct);
    }
}

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
        var html = string.Join("<br>", markdown.Split('\n').Select(line => System.Net.WebUtility.HtmlEncode(line)));
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
}

/// <summary>
/// GitLab issues (REST v4), on gitlab.com or a self-managed instance (<see cref="TrackerSettings.Site"/>).
/// <see cref="TrackerSettings.ProjectKey"/> is the project's path, such as <c>group/subgroup/project</c>. Token: a personal,
/// project or group access token with the <c>api</c> scope, from someone with at least the Reporter role.
/// </summary>
internal sealed class GitLabTracker(IHttpClientFactory http) : IIssueTracker
{
    private static string Project(TrackerSettings s) =>
        $"{(s.Site is { Length: > 0 } site ? site : "https://gitlab.com").TrimEnd('/')}/api/v4/projects/{Uri.EscapeDataString(s.ProjectKey!.Trim().Trim('/'))}";

    private static HttpRequestMessage Request(HttpMethod method, string url, string token, object? body = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = body is null ? null : Trackers.Json(body) };
        request.Headers.Add("PRIVATE-TOKEN", token);
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    public async Task TestAsync(TrackerSettings s, string token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, Project(s), token);
        var project = await Trackers.SendAsync(http, request, ct);
        if (project?["issues_enabled"]?.GetValue<bool>() == false)
        {
            throw new InvalidOperationException("Issues are turned off for this project (Settings → General → Visibility, project features, permissions).");
        }
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, string token, string title, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Project(s)}/issues", token, new { title, description = markdown });
        var issue = await Trackers.SendAsync(http, request, ct);
        // The iid is the number people see (#12); the global id isn't used in project URLs.
        var iid = issue!["iid"]!.GetValue<int>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new CreatedIssue(iid, $"#{iid}", issue["web_url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Project(s)}/issues/{Uri.EscapeDataString(externalId)}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue!["state"]!.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Put, $"{Project(s)}/issues/{Uri.EscapeDataString(externalId)}", token, new { state_event = "close" });
        await Trackers.SendAsync(http, request, ct);
    }
}

/// <summary>
/// Forgejo and Gitea issues (REST v1): Codeberg by default, or a self-hosted instance (<see cref="TrackerSettings.Site"/>).
/// Token: an access token with the <c>issue</c> scope (read and write) and <c>repository</c> (read).
/// </summary>
internal sealed class ForgejoTracker(IHttpClientFactory http) : IIssueTracker
{
    private static string Repo(TrackerSettings s) =>
        $"{(s.Site is { Length: > 0 } site ? site : "https://codeberg.org").TrimEnd('/')}/api/v1/repos/{Uri.EscapeDataString(s.Owner!.Trim())}/{Uri.EscapeDataString(s.Repo!.Trim())}";

    private static HttpRequestMessage Request(HttpMethod method, string url, string token, object? body = null)
    {
        var request = new HttpRequestMessage(method, url) { Content = body is null ? null : Trackers.Json(body) };
        request.Headers.Authorization = new AuthenticationHeaderValue("token", token);
        request.Headers.Accept.ParseAdd("application/json");
        return request;
    }

    public async Task TestAsync(TrackerSettings s, string token, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, Repo(s), token);
        var repo = await Trackers.SendAsync(http, request, ct);
        if (repo?["has_issues"]?.GetValue<bool>() == false)
        {
            throw new InvalidOperationException("Issues are turned off for this repository (Settings → Units).");
        }
    }

    public async Task<CreatedIssue> CreateAsync(TrackerSettings s, string token, string title, string markdown, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Post, $"{Repo(s)}/issues", token, new { title, body = markdown });
        var issue = await Trackers.SendAsync(http, request, ct);
        var number = issue!["number"]!.GetValue<long>().ToString(System.Globalization.CultureInfo.InvariantCulture);
        return new CreatedIssue(number, $"#{number}", issue["html_url"]!.GetValue<string>());
    }

    public async Task<string> StateAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Get, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}", token);
        var issue = await Trackers.SendAsync(http, request, ct);
        return issue!["state"]!.GetValue<string>() == "closed" ? IssueStates.Closed : IssueStates.Open;
    }

    public async Task CloseAsync(TrackerSettings s, string token, string externalId, CancellationToken ct)
    {
        using var request = Request(HttpMethod.Patch, $"{Repo(s)}/issues/{Uri.EscapeDataString(externalId)}", token, new { state = "closed" });
        await Trackers.SendAsync(http, request, ct);
    }
}
