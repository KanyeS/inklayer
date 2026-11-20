using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Features.Notifications;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <param name="TokenHint">The token's last four characters; the token itself is never returned.</param>
public sealed record TrackerConnectionResponse(
    Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind, string Name, TrackerSettings Settings, bool CloseIssueOnResolve, string TokenHint, DateTime? LastErrorAt, string? LastError);

/// <summary>What Commenters need to pick a tracker.</summary>
public sealed record TrackerChoiceResponse(Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind, string Name);

public sealed record CreateTrackerRequest(string Kind, string? Name, string Token, TrackerSettings Settings, bool CloseIssueOnResolve = true);

public sealed record UpdateTrackerRequest(string? Name, string? Token, TrackerSettings? Settings, bool? CloseIssueOnResolve);

public sealed record CreateIssueRequest(Guid ConnectionId, string? Title);

/// <summary>
/// Issue trackers: project Admins connect GitHub, GitLab, Forgejo or Gitea (such as Codeberg), Jira Cloud, Linear or
/// Azure DevOps (as many as they like); Commenters and above create
/// issues from comments. Tokens are encrypted and never returned. Connections are checked against the tracker when saved.
/// </summary>
internal static class IssueEndpoints
{
    public static IEndpointRouteBuilder MapIssueEndpoints(this IEndpointRouteBuilder app)
    {
        var trackers = app.MapGroup("/api/projects/{projectId:guid}/issue-trackers").WithTags("Issues").RequireAuthorization();
        trackers.MapGet("/", ListAsync).Produces<List<TrackerConnectionResponse>>().WithSummary("The project's issue tracker connections (project Admins)");
        trackers.MapGet("/choices", ChoicesAsync).Produces<List<TrackerChoiceResponse>>().WithSummary("Trackers a Commenter can create issues in");
        trackers.MapPost("/", CreateAsync).Produces<TrackerConnectionResponse>(StatusCodes.Status201Created).WithSummary("Connect an issue tracker (checked before saving)");
        trackers.MapPatch("/{id:guid}", UpdateAsync).Produces<TrackerConnectionResponse>();
        trackers.MapDelete("/{id:guid}", DeleteAsync).Produces(StatusCodes.Status204NoContent);
        trackers.MapPost("/{id:guid}/test", TestAsync).Produces<TestResultResponse>().WithSummary("Check the connection still works");

        app.MapPost("/api/annotations/{annotationId:guid}/issues", CreateIssueAsync).Produces<IssueResponse>(StatusCodes.Status201Created).WithTags("Issues").RequireAuthorization()
            .WithSummary("Create an issue from a comment, with its replies, page and page details");
        return app;
    }

    private static async Task<IResult> ListAsync(Guid projectId, AccessService access, InklayerDbContext db, IntegrationSecrets secrets, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var rows = await db.IssueTrackerConnections.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.CreatedAt).ToListAsync(ct);
        return TypedResults.Ok(rows.Select(c => ToResponse(c, secrets)).ToList());
    }

    internal static async Task<IResult> ChoicesAsync(Guid projectId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        return TypedResults.Ok(await db.IssueTrackerConnections.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.CreatedAt)
            .Select(c => new TrackerChoiceResponse(c.Id, c.Kind, c.Name)).ToListAsync(ct));
    }

    private static async Task<IResult> CreateAsync(
        Guid projectId, CreateTrackerRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets,
        Trackers trackers, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (!TrackerKinds.All.Contains(request.Kind))
        {
            return Invalid("kind", $"Choose one of {string.Join(", ", TrackerKinds.All)}.");
        }

        if (Validate(request.Kind, request.Settings) is { } invalid)
        {
            return invalid;
        }

        if (string.IsNullOrWhiteSpace(request.Token))
        {
            return Invalid("token", "A token is required.");
        }

        var token = request.Token.Trim();
        try
        {
            await trackers.For(request.Kind).TestAsync(request.Settings, token, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: $"Couldn't connect to {TrackerKinds.Name(request.Kind)}.", detail: ex.Message);
        }

        var connection = new IssueTrackerConnection
        {
            ProjectId = projectId,
            OrganizationId = check.OrganizationId,
            Kind = request.Kind,
            Name = Name(request.Name, request.Kind, request.Settings),
            Settings = IssueService.SettingsJson(request.Settings),
            ProtectedToken = secrets.Protect(token),
            CloseIssueOnResolve = request.CloseIssueOnResolve,
            CreatedByUserId = currentUser.Id!.Value,
            CreatedAt = clock.GetUtcNow().UtcDateTime,
        };
        db.IssueTrackerConnections.Add(connection);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/projects/{projectId}/issue-trackers/{connection.Id}", ToResponse(connection, secrets));
    }

    private static async Task<IResult> UpdateAsync(
        Guid projectId, Guid id, UpdateTrackerRequest request, AccessService access, InklayerDbContext db, IntegrationSecrets secrets, Trackers trackers, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var connection = await db.IssueTrackerConnections.SingleOrDefaultAsync(c => c.Id == id && c.ProjectId == projectId, ct);
        if (connection is null)
        {
            return TypedResults.NotFound();
        }

        var settings = request.Settings ?? IssueService.SettingsOf(connection);
        if (Validate(connection.Kind, settings) is { } invalid)
        {
            return invalid;
        }

        var token = request.Token is { Length: > 0 } newToken ? newToken.Trim() : secrets.Unprotect(connection.ProtectedToken);
        if (request.Settings is not null || request.Token is { Length: > 0 })
        {
            try
            {
                await trackers.For(connection.Kind).TestAsync(settings, token, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: $"Couldn't connect to {TrackerKinds.Name(connection.Kind)}.", detail: ex.Message);
            }
        }

        connection.Settings = IssueService.SettingsJson(settings);
        connection.ProtectedToken = secrets.Protect(token);
        connection.Name = request.Name is null ? connection.Name : Name(request.Name, connection.Kind, settings);
        connection.CloseIssueOnResolve = request.CloseIssueOnResolve ?? connection.CloseIssueOnResolve;
        connection.LastError = null;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(ToResponse(connection, secrets));
    }

    private static async Task<IResult> DeleteAsync(Guid projectId, Guid id, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        return await db.IssueTrackerConnections.Where(c => c.Id == id && c.ProjectId == projectId).ExecuteDeleteAsync(ct) == 0 ? TypedResults.NotFound() : TypedResults.NoContent();
    }

    private static async Task<IResult> TestAsync(
        Guid projectId, Guid id, AccessService access, InklayerDbContext db, IntegrationSecrets secrets, Trackers trackers, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var connection = await db.IssueTrackerConnections.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id && c.ProjectId == projectId, ct);
        if (connection is null)
        {
            return TypedResults.NotFound();
        }

        try
        {
            await trackers.For(connection.Kind).TestAsync(IssueService.SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), ct);
            return TypedResults.Ok(new TestResultResponse(true, null));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return TypedResults.Ok(new TestResultResponse(false, ex.Message));
        }
    }

    internal static async Task<IResult> CreateIssueAsync(
        Guid annotationId, CreateIssueRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, IssueService issues, CancellationToken ct)
    {
        var comment = await db.Annotations.SingleOrDefaultAsync(a => a.Id == annotationId && a.DeletedAt == null, ct);
        if (comment is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(comment.ProjectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var connection = await db.IssueTrackerConnections.SingleOrDefaultAsync(c => c.Id == request.ConnectionId && c.ProjectId == comment.ProjectId, ct);
        if (connection is null)
        {
            return Invalid("connectionId", "That tracker isn't connected to this comment's project.");
        }

        try
        {
            var issue = await issues.CreateAsync(comment, connection, request.Title, currentUser.Id!.Value, ct);
            return TypedResults.Created(issue.Url, new IssueResponse(issue.Id, connection.Kind, issue.Key, issue.Url, issue.State));
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: $"{TrackerKinds.Name(connection.Kind)} didn't create the issue.", detail: ex.Message);
        }
    }

    private static IResult? Validate(string kind, TrackerSettings s)
    {
        bool Blank(string? v) => string.IsNullOrWhiteSpace(v);
        return kind switch
        {
            TrackerKinds.GitHub when Blank(s.Owner) || Blank(s.Repo) => Invalid("settings", "GitHub needs the repository owner and name."),
            TrackerKinds.GitHub when s.ApiUrl is { Length: > 0 } api && !IsHttps(api) => Invalid("settings", "The GitHub API address must use https."),
            TrackerKinds.Jira when Blank(s.Site) || !IsHttps(s.Site!) || Blank(s.ProjectKey) || Blank(s.Email) =>
                Invalid("settings", "Jira needs the site (https://…atlassian.net), project key, and the account email for the token."),
            TrackerKinds.Linear when Blank(s.TeamId) => Invalid("settings", "Linear needs the team id."),
            TrackerKinds.AzureDevOps when Blank(s.Site) || !IsHttps(s.Site!) || Blank(s.ProjectKey) =>
                Invalid("settings", "Azure DevOps needs the organisation address (https://dev.azure.com/…) and the project."),
            TrackerKinds.GitLab when Blank(s.ProjectKey) => Invalid("settings", "GitLab needs the project's path, such as group/project."),
            TrackerKinds.Forgejo when Blank(s.Owner) || Blank(s.Repo) => Invalid("settings", "Forgejo and Gitea need the repository owner and name."),
            TrackerKinds.GitLab or TrackerKinds.Forgejo when s.Site is { Length: > 0 } site && !IsHttps(site) => Invalid("settings", "The instance address must use https."),
            _ => null,
        };
    }

    private static bool IsHttps(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps;

    private static string Name(string? name, string kind, TrackerSettings s)
    {
        var trimmed = (name ?? "").Trim();
        if (trimmed.Length == 0)
        {
            trimmed = kind switch
            {
                TrackerKinds.GitHub => $"{s.Owner}/{s.Repo}",
                TrackerKinds.Jira => $"Jira {s.ProjectKey}",
                TrackerKinds.AzureDevOps => $"Azure DevOps {s.ProjectKey}",
                TrackerKinds.GitLab => s.ProjectKey!.Trim(),
                TrackerKinds.Forgejo => $"{s.Owner}/{s.Repo}",
                _ => "Linear",
            };
        }

        return trimmed.Length > 100 ? trimmed[..100] : trimmed;
    }

    private static TrackerConnectionResponse ToResponse(IssueTrackerConnection c, IntegrationSecrets secrets)
    {
        var token = secrets.Unprotect(c.ProtectedToken);
        return new TrackerConnectionResponse(c.Id, c.Kind, c.Name, IssueService.SettingsOf(c), c.CloseIssueOnResolve,
            token.Length > 4 ? $"…{token[^4..]}" : "…", c.LastErrorAt, c.LastError);
    }

    private static IResult Invalid(string field, string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });
}
