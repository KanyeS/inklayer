using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Features.Notifications;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <param name="TokenHint">The shared token's last four characters (the token itself is never returned); null without one.</param>
/// <param name="PersonalAccounts">People act as their own connected accounts here; the shared token is only a fallback.</param>
public sealed record TrackerConnectionResponse(
    Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind, string Name, TrackerSettings Settings, bool CloseIssueOnResolve, string? TokenHint, DateTime? LastErrorAt, string? LastError,
    bool PostRepliesToIssue, bool PersonalAccounts);

/// <summary>What Commenters need to pick a tracker, and who they'd act as in it.</summary>
/// <param name="PostsAs"><c>you</c>: your own connected account (<paramref name="Login"/>); <c>shared</c>: the project's shared
/// account; <c>connect</c>: neither, so connect your account first.</param>
public sealed record TrackerChoiceResponse(
    Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind, string Name,
    [property: AllowedValues("you", "shared", "connect")] string PostsAs, string? Login);

/// <param name="Token">The shared account's token. Optional where people can connect their own accounts (GitHub, when the server allows it).</param>
public sealed record CreateTrackerRequest(string Kind, string? Name, string? Token, TrackerSettings Settings, bool CloseIssueOnResolve = true, bool PostRepliesToIssue = false);

/// <param name="RemoveToken">Remove the shared token, so everyone acts as their own account.</param>
public sealed record UpdateTrackerRequest(string? Name, string? Token, TrackerSettings? Settings, bool? CloseIssueOnResolve, bool? PostRepliesToIssue, bool? RemoveToken = null);

/// <param name="Parent">Create the issue under this one (its address, number or key): a sub-task in Jira, a child work item in Azure DevOps.</param>
/// <param name="Type">Jira and Azure DevOps: the issue type, from <c>/issue-trackers/{id}/issue-types</c>; the tracker's own when empty.</param>
public sealed record CreateIssueRequest(Guid ConnectionId, string? Title, [property: StringLength(2000)] string? Parent = null, [property: StringLength(200)] string? Type = null);

/// <summary>
/// Which types issues can be created as, for a tracker's settings before they're saved. <see cref="Token"/>: a shared token
/// being entered; else <see cref="ConnectionId"/>'s saved one, else your own connected account.
/// </summary>
public sealed record IssueTypesRequest(string Kind, TrackerSettings Settings, string? Token = null, Guid? ConnectionId = null);

/// <param name="Types">Empty for trackers without issue types (GitHub, GitLab, Forgejo, Linear).</param>
/// <param name="Suggested">The one to pick: the current type if the project has it, else Bug, Issue or Task, else the first.</param>
public sealed record IssueTypesResponse(List<string> Types, string? Suggested);

/// <param name="Reference">The issue's address or number (<c>#12</c>, <c>ABC-12</c>, <c>ENG-5</c>), or a search result's url.</param>
/// <param name="AddComment">Post the comment, with its replies, page and details, on the issue.</param>
public sealed record LinkIssueRequest(Guid ConnectionId, [property: Required, StringLength(2000)] string? Reference, bool AddComment = true);

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
        trackers.MapPost("/issue-types", IssueTypesAsync).Produces<IssueTypesResponse>()
            .WithSummary("The types issues can be created as, for a tracker's settings (project Admins)");
        trackers.MapGet("/{id:guid}/issue-types", TrackerIssueTypesAsync).Produces<IssueTypesResponse>()
            .WithSummary("The types you can create issues as in a connected tracker (Commenters and above)");
        trackers.MapPost("/{id:guid}/test", TestAsync).Produces<TestResultResponse>().WithSummary("Check the connection still works");
        trackers.MapGet("/{id:guid}/search", SearchIssuesAsync).Produces<List<FoundIssue>>()
            .WithSummary("Open issues matching a title, or the issue an address or number points to (Commenters)");

        app.MapPost("/api/annotations/{annotationId:guid}/issues", CreateIssueAsync).Produces<IssueResponse>(StatusCodes.Status201Created).WithTags("Issues").RequireAuthorization()
            .WithSummary("Create an issue from a comment, with its replies, page and page details");
        app.MapPost("/api/annotations/{annotationId:guid}/issues/link", LinkIssueAsync).Produces<IssueResponse>(StatusCodes.Status201Created).WithTags("Issues").RequireAuthorization()
            .WithSummary("Link an issue that already exists to a comment, optionally adding the comment to it");
        return app;
    }

    private static async Task<IResult> ListAsync(Guid projectId, AccessService access, InklayerDbContext db, IntegrationSecrets secrets, TrackerAccounts accounts, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var rows = await db.IssueTrackerConnections.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.CreatedAt).ToListAsync(ct);
        return TypedResults.Ok(rows.Select(c => ToResponse(c, secrets, accounts)).ToList());
    }

    internal static async Task<IResult> ChoicesAsync(
        Guid projectId, AccessService access, CurrentUser currentUser, InklayerDbContext db, TrackerAccounts accounts, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var userId = currentUser.Id!.Value;
        var connections = await db.IssueTrackerConnections.AsNoTracking().Where(c => c.ProjectId == projectId).OrderBy(c => c.CreatedAt).ToListAsync(ct);
        var mine = await db.TrackerAccounts.AsNoTracking().Where(a => a.UserId == userId).ToDictionaryAsync(a => a.Kind, a => a.Login, ct);
        return TypedResults.Ok(connections.Select(c =>
        {
            var login = accounts.PersonalFor(c) ? mine.GetValueOrDefault(c.Kind) : null;
            var postsAs = login is not null ? "you" : c.ProtectedToken is not null ? "shared" : "connect";
            return new TrackerChoiceResponse(c.Id, c.Kind, c.Name, postsAs, login);
        }).ToList());
    }

    private static async Task<IResult> CreateAsync(
        Guid projectId, CreateTrackerRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets,
        Trackers trackers, TrackerAccounts accounts, TimeProvider clock, CancellationToken ct)
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

        // Where people connect their own accounts, the shared token is optional; the admin's own account checks the settings.
        var shared = request.Token?.Trim() is { Length: > 0 } t ? t : null;
        if (Validate(request.Kind, request.Settings, shared is not null) is { } invalid)
        {
            return invalid;
        }

        var personal = accounts.PersonalFor(request.Kind, request.Settings);
        if (shared is null && !personal)
        {
            return Invalid("token", "A token is required.");
        }

        try
        {
            var token = shared is not null ? shared : await OwnAsync(accounts, currentUser, request.Kind, request.Settings, ct);
            if (token is null)
            {
                return Invalid("token", OwnNeeded(request.Kind));
            }

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
            ProtectedToken = shared is null ? null : secrets.Protect(shared),
            CloseIssueOnResolve = request.CloseIssueOnResolve,
            PostRepliesToIssue = request.PostRepliesToIssue,
            CreatedByUserId = currentUser.Id!.Value,
            CreatedAt = clock.GetUtcNow().UtcDateTime,
        };
        db.IssueTrackerConnections.Add(connection);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/projects/{projectId}/issue-trackers/{connection.Id}", ToResponse(connection, secrets, accounts));
    }

    private static async Task<IResult> UpdateAsync(
        Guid projectId, Guid id, UpdateTrackerRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets,
        Trackers trackers, TrackerAccounts accounts, CancellationToken ct)
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
        var personal = accounts.PersonalFor(connection.Kind, settings);
        var shared = request.Token?.Trim() is { Length: > 0 } newToken ? newToken
            : request.RemoveToken == true ? null
            : connection.ProtectedToken is { } old ? secrets.Unprotect(old) : null;
        if (Validate(connection.Kind, settings, shared is not null) is { } invalid)
        {
            return invalid;
        }

        if (shared is null && !personal)
        {
            return Invalid("token", $"{TrackerKinds.Name(connection.Kind)} needs a shared token here: people can't connect their own accounts to it.");
        }

        if (request.Settings is not null || request.Token is { Length: > 0 })
        {
            try
            {
                var token = shared is not null ? shared : await OwnAsync(accounts, currentUser, connection.Kind, settings, ct);
                if (token is null)
                {
                    return Invalid("token", OwnNeeded(connection.Kind));
                }

                await trackers.For(connection.Kind).TestAsync(settings, token, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: $"Couldn't connect to {TrackerKinds.Name(connection.Kind)}.", detail: ex.Message);
            }
        }

        connection.Settings = IssueService.SettingsJson(settings);
        connection.ProtectedToken = shared is null ? null : secrets.Protect(shared);
        connection.Name = request.Name is null ? connection.Name : Name(request.Name, connection.Kind, settings);
        connection.CloseIssueOnResolve = request.CloseIssueOnResolve ?? connection.CloseIssueOnResolve;
        connection.PostRepliesToIssue = request.PostRepliesToIssue ?? connection.PostRepliesToIssue;
        connection.LastError = null;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(ToResponse(connection, secrets, accounts));
    }

    private static async Task<IResult> IssueTypesAsync(
        Guid projectId, IssueTypesRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets,
        Trackers trackers, TrackerAccounts accounts, CancellationToken ct)
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

        if (trackers.For(request.Kind) is not IIssueTypes typed)
        {
            return TypedResults.Ok(new IssueTypesResponse([], null));
        }

        var saved = request.ConnectionId is { } id
            ? await db.IssueTrackerConnections.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id && c.ProjectId == projectId && c.Kind == request.Kind, ct)
            : null;
        var shared = request.Token?.Trim() is { Length: > 0 } t ? t : saved?.ProtectedToken is { } p ? secrets.Unprotect(p) : null;
        if (Validate(request.Kind, request.Settings, shared is not null) is { } invalid)
        {
            return invalid;
        }

        try
        {
            var token = shared is not null ? shared
                : accounts.PersonalFor(request.Kind, request.Settings) ? await OwnAsync(accounts, currentUser, request.Kind, request.Settings, ct)
                : null;
            if (token is null)
            {
                return Invalid("token", accounts.PersonalFor(request.Kind, request.Settings) ? OwnNeeded(request.Kind) : "A token is required.");
            }

            var types = (await typed.IssueTypesAsync(request.Settings, token, ct)).ToList();
            return TypedResults.Ok(new IssueTypesResponse(types, IssueService.SuggestedType(types, request.Settings.IssueType)));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: $"Couldn't read the types from {TrackerKinds.Name(request.Kind)}.", detail: ex.Message);
        }
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
        Guid projectId, Guid id, AccessService access, CurrentUser currentUser, InklayerDbContext db, Trackers trackers, TrackerAccounts accounts, CancellationToken ct)
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

        // The shared account if there is one, else the admin's own.
        if (await accounts.ForUserAsync(connection, currentUser.Id!.Value, ct) is not { } token)
        {
            return TypedResults.Ok(new TestResultResponse(false, TrackerAccounts.NeededMessage(connection.Kind)));
        }

        try
        {
            await trackers.For(connection.Kind).TestAsync(IssueService.SettingsOf(connection), (accounts.Shared(connection) ?? token).Auth, ct);
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
            var issue = await issues.CreateAsync(comment, connection, request.Title, currentUser.Id!.Value, ct, request.Parent, request.Type);
            return TypedResults.Created(issue.Url, new IssueResponse(issue.Id, connection.Kind, issue.Key, issue.Url, issue.State));
        }
        catch (TrackerAccountNeededException ex)
        {
            return AccountNeeded(ex);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: $"{TrackerKinds.Name(connection.Kind)} didn't create the issue.", detail: ex.Message);
        }
    }

    internal static async Task<IResult> TrackerIssueTypesAsync(
        Guid projectId, Guid id, AccessService access, CurrentUser currentUser, InklayerDbContext db, IssueService issues, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Comment, ct);
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
            var (types, suggested) = await issues.IssueTypesAsync(connection, currentUser.Id!.Value, ct);
            return TypedResults.Ok(new IssueTypesResponse([.. types], suggested));
        }
        catch (TrackerAccountNeededException ex)
        {
            return AccountNeeded(ex);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: $"Couldn't read the types from {TrackerKinds.Name(connection.Kind)}.", detail: ex.Message);
        }
    }

    internal static async Task<IResult> SearchIssuesAsync(
        Guid projectId, Guid id, string? q, AccessService access, CurrentUser currentUser, InklayerDbContext db, IssueService issues, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var connection = await db.IssueTrackerConnections.AsNoTracking().SingleOrDefaultAsync(c => c.Id == id && c.ProjectId == projectId, ct);
        if (connection is null)
        {
            return TypedResults.NotFound();
        }

        var query = (q ?? "").Trim();
        var userId = currentUser.Id!.Value;
        try
        {
            if (!LooksLikeReference(query))
            {
                return TypedResults.Ok((await issues.SearchAsync(connection, query.Length > 200 ? query[..200] : query, userId, ct)).ToList());
            }

            try
            {
                return TypedResults.Ok(new List<FoundIssue> { await issues.FindAsync(connection, query, userId, ct) });
            }
            catch (HttpRequestException ex) when (ex.Message.StartsWith("Not found", StringComparison.Ordinal))
            {
                return TypedResults.Ok(new List<FoundIssue>());
            }
        }
        catch (TrackerAccountNeededException ex)
        {
            return AccountNeeded(ex);
        }
        catch (InvalidOperationException ex)
        {
            return Invalid("q", ex.Message);
        }
        catch (HttpRequestException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: $"{TrackerKinds.Name(connection.Kind)} didn't answer the search.", detail: ex.Message);
        }
    }

    /// <summary>An address, a number (<c>12</c>, <c>#12</c>) or a key (<c>ABC-12</c>), rather than words to search titles for.</summary>
    private static bool LooksLikeReference(string query) =>
        query.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || query.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
        || System.Text.RegularExpressions.Regex.IsMatch(query, @"^(#?\d{1,12}|[A-Za-z][A-Za-z0-9_]*-\d{1,12})$");

    internal static async Task<IResult> LinkIssueAsync(
        Guid annotationId, LinkIssueRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, IssueService issues, CancellationToken ct)
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

        if (request.Reference?.Trim() is not { Length: > 0 } reference)
        {
            return Invalid("reference", "Give the issue's address or number.");
        }

        FoundIssue found;
        try
        {
            found = await issues.FindAsync(connection, reference, currentUser.Id!.Value, ct);
        }
        catch (TrackerAccountNeededException ex)
        {
            return AccountNeeded(ex);
        }
        catch (InvalidOperationException ex)
        {
            return Invalid("reference", ex.Message);
        }
        catch (HttpRequestException ex)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: $"{TrackerKinds.Name(connection.Kind)} didn't find the issue.", detail: ex.Message);
        }

        if (await db.AnnotationIssues.AnyAsync(i => i.AnnotationId == comment.Id && i.ConnectionId == connection.Id && i.ExternalId == found.ExternalId, ct))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: $"{found.Key} is already linked to this comment.");
        }

        try
        {
            var issue = await issues.LinkAsync(comment, connection, found, request.AddComment, currentUser.Id!.Value, ct);
            return TypedResults.Created(issue.Url, new IssueResponse(issue.Id, connection.Kind, issue.Key, issue.Url, issue.State));
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status502BadGateway, title: $"{TrackerKinds.Name(connection.Kind)} didn't take the comment.", detail: ex.Message);
        }
    }

    /// <summary>The admin's own account, to check a connection's settings without a shared token; null if they haven't connected one.</summary>
    private static async Task<TrackerAuth?> OwnAsync(TrackerAccounts accounts, CurrentUser currentUser, string kind, TrackerSettings settings, CancellationToken ct) =>
        await accounts.AccountAsync(currentUser.Id!.Value, kind, ct) is { } own && await accounts.TokenAsync(own, settings, ct) is { } token ? token.Auth : null;

    private static string OwnNeeded(string kind) =>
        $"Connect your own {TrackerKinds.Name(kind)} account first (on the home page, under Tracker accounts), so Inklayer can check the settings; or add a shared token.";

    /// <param name="sharedToken">Whether the connection has a shared token: Jira's needs the account email that goes with it.</param>
    private static IResult? Validate(string kind, TrackerSettings s, bool sharedToken)
    {
        bool Blank(string? v) => string.IsNullOrWhiteSpace(v);
        return kind switch
        {
            TrackerKinds.GitHub when Blank(s.Owner) || Blank(s.Repo) => Invalid("settings", "GitHub needs the repository owner and name."),
            TrackerKinds.GitHub when s.ApiUrl is { Length: > 0 } api && !IsHttps(api) => Invalid("settings", "The GitHub API address must use https."),
            TrackerKinds.Jira when Blank(s.Site) || !IsHttps(s.Site!) || Blank(s.ProjectKey) || (sharedToken && Blank(s.Email)) =>
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

    private static TrackerConnectionResponse ToResponse(IssueTrackerConnection c, IntegrationSecrets secrets, TrackerAccounts accounts)
    {
        var token = c.ProtectedToken is { } t ? secrets.Unprotect(t) : null;
        return new TrackerConnectionResponse(c.Id, c.Kind, c.Name, IssueService.SettingsOf(c), c.CloseIssueOnResolve,
            token is null ? null : token.Length > 4 ? $"…{token[^4..]}" : "…", c.LastErrorAt, c.LastError, c.PostRepliesToIssue, accounts.PersonalFor(c));
    }

    /// <summary>The person needs to connect their own account (and there's no shared one): 409, saying how.</summary>
    private static IResult AccountNeeded(TrackerAccountNeededException ex) =>
        TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: ex.Message, type: "tracker-account-needed");

    private static IResult Invalid(string field, string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });
}
