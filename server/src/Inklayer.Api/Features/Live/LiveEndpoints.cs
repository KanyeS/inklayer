using Inklayer.Api.Access;
using Inklayer.Api.Features.Annotations;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Projects;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Live;

/// <summary>One site the extension should show annotations on, and the project they belong to.</summary>
public sealed record LiveSiteResponse(
    Guid ProjectId, string ProjectName, Guid OrganizationId, string OrganizationName, string Origin, bool MatchQuery, bool MatchHash, Role MyRole);

/// <summary>A live page's annotations. <see cref="PageUrl"/> is the normalised key the annotations are stored under.</summary>
public sealed record LivePageAnnotationsResponse(string PageUrl, IReadOnlyList<AnnotationResponse> Annotations);

public sealed record LivePageSummaryResponse(string PageUrl, int OpenCount, int ResolvedCount, DateTime LastActivityAt);

/// <summary>
/// Live mode: annotations on real pages of a project's sites, shown by the browser extension.
/// <list type="bullet">
/// <item>The extension first asks which sites to watch (<c>/api/live/sites</c>), so it only runs on, and only reports, pages on those sites.</item>
/// <item>A page URL must be on one of the project's sites. The server normalises it with the project's matching rules before storing or looking it up.</item>
/// </list>
/// Editing, resolving, deleting and history use the shared <c>/api/annotations/{id}</c> endpoints.
/// </summary>
internal static class LiveEndpoints
{
    public static IEndpointRouteBuilder MapLiveEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/live/sites", SitesAsync).WithTags("Live").RequireAuthorization()
            .WithSummary("Every live site of every project the caller can view");

        var byProject = app.MapGroup("/api/projects/{projectId:guid}/live").WithTags("Live").RequireAuthorization();
        byProject.MapGet("/annotations", ListAsync).WithSummary("Annotations on one live page: ?url=<the page's address>");
        byProject.MapPost("/annotations", CreateAsync);
        byProject.MapGet("/pages", PagesAsync).WithSummary("Live pages with annotations, most recently active first");

        return app;
    }

    private static async Task<IResult> SitesAsync(CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var user = await currentUser.GetAsync(ct);
        if (user is null || user.IsDisabled)
        {
            return TypedResults.Unauthorized();
        }

        var orgRoles = user.IsSystemAdmin
            ? await db.Organizations.ToDictionaryAsync(o => o.Id, _ => Role.Owner, ct)
            : await db.OrganizationMembers.Where(m => m.UserId == user.Id).ToDictionaryAsync(m => m.OrganizationId, m => m.Role, ct);
        var orgIds = orgRoles.Keys.ToList();
        var orgNames = await db.Organizations.Where(o => orgIds.Contains(o.Id)).ToDictionaryAsync(o => o.Id, o => o.Name, ct);
        var overrides = await db.ProjectMembers.Where(m => m.UserId == user.Id).ToDictionaryAsync(m => m.ProjectId, m => m.Role, ct);
        var projects = await db.Projects.AsNoTracking()
            .Where(p => !p.IsArchived && orgIds.Contains(p.OrganizationId))
            .OrderBy(p => p.Name)
            .ToListAsync(ct);

        var sites = new List<LiveSiteResponse>();
        foreach (var project in projects.Where(p => p.LiveSites.Count > 0))
        {
            var role = PermissionPolicy.EffectiveProjectRole(orgRoles[project.OrganizationId], overrides.TryGetValue(project.Id, out var r) ? r : null);
            if (!role.Grants(Permission.View))
            {
                continue;
            }

            sites.AddRange(project.LiveSites.Select(origin => new LiveSiteResponse(
                project.Id, project.Name, project.OrganizationId, orgNames.GetValueOrDefault(project.OrganizationId, ""), origin,
                project.LiveMatchQuery, project.LiveMatchHash, role)));
        }

        return TypedResults.Ok(sites);
    }

    private static async Task<IResult> ListAsync(Guid projectId, string? url, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var project = await db.Projects.AsNoTracking().SingleAsync(p => p.Id == projectId, ct);
        if (PageKey(project, url) is not { } key)
        {
            return NotALiveSite(project);
        }

        var annotations = await db.Annotations.AsNoTracking()
            .Where(a => a.ProjectId == projectId && a.PageUrl == key && a.DeletedAt == null)
            .OrderBy(a => a.CreatedAt)
            .ToListAsync(ct);
        var authors = await AnnotationEndpoints.AuthorsAsync(db, annotations.Select(a => a.AuthorUserId), ct);
        var userId = currentUser.Id!.Value;
        return TypedResults.Ok(new LivePageAnnotationsResponse(key, annotations.Select(a => AnnotationEndpoints.ToResponse(a, authors, check.Role, userId)).ToList()));
    }

    private static async Task<IResult> CreateAsync(
        Guid projectId, CreateLiveAnnotationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var project = await db.Projects.AsNoTracking().SingleAsync(p => p.Id == projectId, ct);
        if (PageKey(project, request.Url) is not { } key)
        {
            return NotALiveSite(project);
        }

        var target = new AnnotationEndpoints.AnnotationTarget(projectId, project.OrganizationId, SnapshotId: null, PageUrl: key);
        return await AnnotationEndpoints.CreateCoreAsync(
            target, request.Kind!.Value, request.Body, request.Color, request.Anchor, request.Geometry, request.ViewportWidth, check.Role, currentUser, db, clock, ct);
    }

    private static async Task<IResult> PagesAsync(Guid projectId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var pages = await db.Annotations.AsNoTracking()
            .Where(a => a.ProjectId == projectId && a.PageUrl != null && a.DeletedAt == null)
            .GroupBy(a => a.PageUrl!)
            .Select(g => new LivePageSummaryResponse(
                g.Key,
                g.Count(a => a.Status == Domain.Annotations.AnnotationStatus.Open),
                g.Count(a => a.Status == Domain.Annotations.AnnotationStatus.Resolved),
                g.Max(a => a.UpdatedAt)))
            .ToListAsync(ct);
        return TypedResults.Ok(pages.OrderByDescending(p => p.LastActivityAt).ToList());
    }

    /// <summary>The normalised page key, or null if <paramref name="url"/> isn't a page on one of the project's live sites.</summary>
    private static string? PageKey(Project project, string? url)
    {
        var origin = LivePageUrl.OriginOf(url);
        return origin is not null && project.LiveSites.Contains(origin, StringComparer.Ordinal)
            ? LivePageUrl.Normalize(url, project.LiveMatchQuery, project.LiveMatchHash)
            : null;
    }

    private static IResult NotALiveSite(Project project) => TypedResults.ValidationProblem(
        new Dictionary<string, string[]>
        {
            ["url"] = [project.LiveSites.Count == 0
                ? "This project has no live sites yet. A project Admin can add them in the project's settings."
                : $"Must be a page on one of this project's live sites: {string.Join(", ", project.LiveSites)}."],
        });
}
