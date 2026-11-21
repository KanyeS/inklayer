using Inklayer.Api.Access;
using Inklayer.Api.Features.Annotations;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Users;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Live;

/// <summary>A project the caller can use on live pages. Viewers see comments; Commenters and above can add them.</summary>
public sealed record LiveProjectResponse(Guid Id, string Name, Guid OrganizationId, string OrganizationName, Role MyRole, bool CanComment);

/// <summary>One project's annotations on a live page stored under one key (<see cref="PageUrl"/>), e.g. <c>/watch</c> or <c>/watch?v=…</c>.</summary>
public sealed record LivePageAnnotationsResponse(Guid ProjectId, string PageUrl, IReadOnlyList<AnnotationResponse> Annotations);

/// <summary>A page with comments in one project: how many are open and resolved, and the issues made from them.</summary>
public sealed record LivePageSummaryResponse(
    string PageUrl, int OpenCount, int ResolvedCount, DateTime LastActivityAt,
    Guid ProjectId, string? ProjectName, string? OrganizationName, int IssueCount, int OpenIssueCount);

/// <summary>
/// Live mode: annotations on real pages, on any site, shown by the browser extension.
/// <list type="bullet">
/// <item><c>/api/live/origins</c>: the sites (origins only) that have comments the caller can see. The extension checks this
/// list locally, so it only sends the server a page's full address on sites that have comments, or when the user opens the panel.</item>
/// <item><c>/api/live/annotations?url=</c>: a page's comments across every project the caller can view.</item>
/// <item>A comment's key is the page URL with or without its query and #hash, as the commenter chose (see <see cref="LivePageUrl"/>).
/// A page shows the comments stored under any of its keys.</item>
/// </list>
/// Editing, resolving, deleting and history use the shared <c>/api/annotations/{id}</c> endpoints.
/// </summary>
internal static class LiveEndpoints
{
    public static IEndpointRouteBuilder MapLiveEndpoints(this IEndpointRouteBuilder app)
    {
        var live = app.MapGroup("/api/live").WithTags("Live").RequireAuthorization();
        live.MapGet("/origins", OriginsAsync).Produces<List<string>>().WithSummary("Sites (scheme://host[:port]) with live comments the caller can see");
        live.MapGet("/projects", ProjectsAsync).Produces<List<LiveProjectResponse>>().WithSummary("Projects the caller can use on live pages, with their role");
        live.MapGet("/pages", AllPagesAsync).Produces<List<LivePageSummaryResponse>>().WithSummary("Every page with comments in every project the caller can view, most recently active first");
        LivePullRequests.Map(live);
        live.MapGet("/annotations", ListAsync).Produces<List<LivePageAnnotationsResponse>>().WithSummary("Comments on one live page across the caller's projects: ?url=<the page's address>");

        var byProject = app.MapGroup("/api/projects/{projectId:guid}/live").WithTags("Live").RequireAuthorization();
        byProject.MapPost("/annotations", CreateAsync).Produces<AnnotationResponse>(StatusCodes.Status201Created);
        byProject.MapGet("/pages", PagesAsync).Produces<List<LivePageSummaryResponse>>().WithSummary("Live pages with comments, most recently active first");

        return app;
    }

    /// <summary>Every non-archived project the caller can view, with their effective role. Null if the caller is signed out or disabled.</summary>
    internal static async Task<List<(Project Project, Role Role, string OrganizationName)>?> VisibleProjectsAsync(CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var user = await currentUser.GetAsync(ct);
        return user is null || user.IsDisabled ? null : await VisibleProjectsAsync(user, db, ct);
    }

    /// <summary>Every non-archived project <paramref name="user"/> can view, with their effective role.</summary>
    internal static async Task<List<(Project Project, Role Role, string OrganizationName)>> VisibleProjectsAsync(User user, InklayerDbContext db, CancellationToken ct)
    {
        var orgRoles = user.IsSystemAdmin
            ? await db.Organizations.ToDictionaryAsync(o => o.Id, _ => Role.Owner, ct)
            : await db.OrganizationMembers.Where(m => m.UserId == user.Id).ToDictionaryAsync(m => m.OrganizationId, m => m.Role, ct);
        var orgIds = orgRoles.Keys.ToList();
        var orgNames = await db.Organizations.Where(o => orgIds.Contains(o.Id)).ToDictionaryAsync(o => o.Id, o => o.Name, ct);
        var overrides = await db.ProjectMembers.Where(m => m.UserId == user.Id).ToDictionaryAsync(m => m.ProjectId, m => m.Role, ct);
        var projects = await db.Projects.AsNoTracking()
            .Where(p => !p.IsArchived && orgIds.Contains(p.OrganizationId))
            .ToListAsync(ct);

        return projects
            .Select(p => (Project: p, Role: PermissionPolicy.EffectiveProjectRole(orgRoles[p.OrganizationId], overrides.TryGetValue(p.Id, out var r) ? r : null), OrganizationName: orgNames.GetValueOrDefault(p.OrganizationId, "")))
            .Where(x => x.Role.Grants(Permission.View))
            .OrderBy(x => x.OrganizationName, StringComparer.OrdinalIgnoreCase).ThenBy(x => x.Project.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static async Task<IResult> OriginsAsync(CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await VisibleProjectsAsync(currentUser, db, ct) is not { } visible)
        {
            return TypedResults.Unauthorized();
        }

        var ids = visible.Select(v => v.Project.Id).ToList();
        var pages = await db.Annotations.AsNoTracking()
            .Where(a => ids.Contains(a.ProjectId) && a.DeletedAt == null)
            .Select(a => a.PageUrl)
            .Distinct()
            .ToListAsync(ct);
        return TypedResults.Ok(pages.Select(LivePageUrl.OriginOf).OfType<string>().Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList());
    }

    private static async Task<IResult> ProjectsAsync(CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await VisibleProjectsAsync(currentUser, db, ct) is not { } visible)
        {
            return TypedResults.Unauthorized();
        }

        return TypedResults.Ok(visible.Select(v => new LiveProjectResponse(
            v.Project.Id, v.Project.Name, v.Project.OrganizationId, v.OrganizationName, v.Role, v.Role.Grants(Permission.Comment))).ToList());
    }

    internal static async Task<IResult> ListAsync(string? url, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await VisibleProjectsAsync(currentUser, db, ct) is not { } visible)
        {
            return TypedResults.Unauthorized();
        }

        // The page with and without its query and #hash: at most four keys.
        var keys = LivePageUrl.Candidates(url);
        if (keys.Count == 0)
        {
            return InvalidUrl();
        }

        var ids = visible.Select(v => v.Project.Id).ToList();
        var annotations = await db.Annotations.AsNoTracking()
            .Where(a => ids.Contains(a.ProjectId) && keys.Contains(a.PageUrl) && a.DeletedAt == null)
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(ct);
        if (annotations.Count == 0)
        {
            return TypedResults.Ok(Array.Empty<LivePageAnnotationsResponse>());
        }

        var authors = await AnnotationEndpoints.AuthorsAsync(db, annotations.Select(a => a.AuthorUserId), ct);
        var userId = currentUser.Id!.Value;
        var roles = visible.ToDictionary(v => v.Project.Id, v => v.Role);
        var responses = (await AnnotationEndpoints.EnrichAsync(
                db, [.. annotations.Select(a => AnnotationEndpoints.ToResponse(a, authors, roles[a.ProjectId], userId))], p => roles[p], userId, ct))
            .ToDictionary(r => r.Id);
        return TypedResults.Ok(annotations
            .GroupBy(a => (a.ProjectId, a.PageUrl))
            .Select(g => new LivePageAnnotationsResponse(g.Key.ProjectId, g.Key.PageUrl, g.Select(a => responses[a.Id]).ToList()))
            .ToList());
    }

    private static async Task<IResult> CreateAsync(
        Guid projectId, CreateLiveAnnotationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, Docs.DocIndexer indexer,
        Notifications.NotificationService notifications, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var project = await db.Projects.AsNoTracking().SingleAsync(p => p.Id == projectId, ct);
        if (project.IsArchived)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This project is archived.");
        }

        if (LivePageUrl.Normalize(request.Url, request.IncludeQuery, request.IncludeHash) is not { } key)
        {
            return InvalidUrl();
        }

        var target = new AnnotationEndpoints.AnnotationTarget(projectId, project.OrganizationId, key);
        return await AnnotationEndpoints.CreateCoreAsync(
            target, request.Kind!.Value, request.Body, request.Color, request.Anchor, request.Geometry, request.ViewportWidth, check.Role, currentUser, db, indexer, notifications, clock, ct);
    }

    internal static async Task<IResult> PagesAsync(Guid projectId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var name = await db.Projects.Where(p => p.Id == projectId).Select(p => p.Name).SingleAsync(ct);
        return TypedResults.Ok(await SummariesAsync(db, new() { [projectId] = (name, "") }, ct));
    }

    internal static async Task<IResult> AllPagesAsync(CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await VisibleProjectsAsync(currentUser, db, ct) is not { } visible)
        {
            return TypedResults.Unauthorized();
        }

        return TypedResults.Ok(await SummariesAsync(db, visible.ToDictionary(v => v.Project.Id, v => (v.Project.Name, v.OrganizationName)), ct));
    }

    /// <summary>Pages with comments in <paramref name="projects"/> (id → project and organisation names), most recently active first.</summary>
    private static async Task<List<LivePageSummaryResponse>> SummariesAsync(
        InklayerDbContext db, Dictionary<Guid, (string Project, string Organization)> projects, CancellationToken ct)
    {
        var ids = projects.Keys.ToList();
        var pages = await db.Annotations.AsNoTracking()
            .Where(a => ids.Contains(a.ProjectId) && a.DeletedAt == null)
            .GroupBy(a => new { a.ProjectId, a.PageUrl })
            .Select(g => new
            {
                g.Key.ProjectId, g.Key.PageUrl,
                Open = g.Count(a => a.Status == AnnotationStatus.Open),
                Resolved = g.Count(a => a.Status == AnnotationStatus.Resolved),
                Last = g.Max(a => a.UpdatedAt),
            })
            .ToListAsync(ct);
        var issues = (await (from i in db.AnnotationIssues.AsNoTracking()
                             join a in db.Annotations.AsNoTracking() on i.AnnotationId equals a.Id
                             where ids.Contains(a.ProjectId) && a.DeletedAt == null
                             group i by new { a.ProjectId, a.PageUrl } into g
                             select new { g.Key.ProjectId, g.Key.PageUrl, All = g.Count(), Open = g.Count(i => i.State == IssueStates.Open) })
                .ToListAsync(ct))
            .ToDictionary(x => (x.ProjectId, x.PageUrl));
        return [.. pages
            .Select(p =>
            {
                var linked = issues.GetValueOrDefault((p.ProjectId, p.PageUrl));
                var (project, organization) = projects[p.ProjectId];
                return new LivePageSummaryResponse(p.PageUrl, p.Open, p.Resolved, p.Last, p.ProjectId, project, organization, linked?.All ?? 0, linked?.Open ?? 0);
            })
            .OrderByDescending(p => p.LastActivityAt)];
    }

    private static IResult InvalidUrl() => TypedResults.ValidationProblem(
        new Dictionary<string, string[]> { ["url"] = ["Must be the address of a web page (http or https)."] });
}
