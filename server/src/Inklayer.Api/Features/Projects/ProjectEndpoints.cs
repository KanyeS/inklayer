using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Projects;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Projects;

public sealed record CreateProjectRequest([property: Required, StringLength(200, MinimumLength = 1)] string Name);

/// <summary>
/// Only the fields that are present change.
/// <list type="bullet">
/// <item><see cref="LiveSites"/> replaces the whole list. Entries are site addresses like <c>https://app.example.com</c>.</item>
/// <item>Loosening <see cref="LiveMatchQuery"/> or <see cref="LiveMatchHash"/> merges existing live pages that now count as the same page.</item>
/// </list>
/// </summary>
public sealed record UpdateProjectRequest(
    [property: StringLength(200, MinimumLength = 1)] string? Name,
    bool? IsArchived,
    List<string>? LiveSites,
    bool? LiveMatchQuery,
    bool? LiveMatchHash);

public sealed record ProjectResponse(
    Guid Id, Guid OrganizationId, string Name, bool IsArchived, DateTime CreatedAt, Role MyRole,
    IReadOnlyList<string> LiveSites, bool LiveMatchQuery, bool LiveMatchHash);

public sealed record ProjectMemberResponse(Guid UserId, string Email, string DisplayName, Role OrganizationRole, Role? ProjectRole, Role EffectiveRole);

public sealed record SetProjectRoleRequest([property: Required] Role? Role);

internal static class ProjectEndpoints
{
    public static IEndpointRouteBuilder MapProjectEndpoints(this IEndpointRouteBuilder app)
    {
        var byOrg = app.MapGroup("/api/orgs/{orgId:guid}/projects").WithTags("Projects").RequireAuthorization();
        byOrg.MapGet("/", ListAsync);
        byOrg.MapPost("/", CreateAsync);

        var projects = app.MapGroup("/api/projects").WithTags("Projects").RequireAuthorization();
        projects.MapGet("/{projectId:guid}", GetAsync).WithName("GetProject");
        projects.MapPatch("/{projectId:guid}", UpdateAsync);
        projects.MapGet("/{projectId:guid}/members", ListMembersAsync).WithSummary("Every organisation member's effective role in this project");
        projects.MapPut("/{projectId:guid}/members/{userId:guid}", SetRoleAsync)
            .WithSummary("Override a member's role in this project (Viewer, Commenter or Editor). Doesn't apply to organisation Admins and Owners.");
        projects.MapDelete("/{projectId:guid}/members/{userId:guid}", RemoveRoleAsync).WithSummary("Remove the override; the organisation role applies again");

        return app;
    }

    private static async Task<IResult> ListAsync(Guid orgId, bool? includeArchived, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var overrides = await access.GetProjectOverridesAsync(orgId, ct);
        var projects = await db.Projects.AsNoTracking()
            .Where(p => p.OrganizationId == orgId && (includeArchived == true || !p.IsArchived))
            .OrderBy(p => p.Name)
            .ToListAsync(ct);

        return TypedResults.Ok(projects
            .Select(p => ToResponse(p, PermissionPolicy.EffectiveProjectRole(check.Role, overrides.TryGetValue(p.Id, out var r) ? r : null)))
            .ToList());
    }

    private static async Task<IResult> CreateAsync(Guid orgId, CreateProjectRequest request, AccessService access, InklayerDbContext db, AuditLog audit, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var project = new Project { OrganizationId = orgId, Name = request.Name.Trim(), CreatedAt = clock.GetUtcNow().UtcDateTime };
        db.Projects.Add(project);
        audit.Record(AuditActions.ProjectCreated, orgId, "project", project.Id, new { project.Name });
        await db.SaveChangesAsync(ct);
        return TypedResults.CreatedAtRoute(ToResponse(project, check.Role), "GetProject", new { projectId = project.Id });
    }

    private static async Task<IResult> GetAsync(Guid projectId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var project = await db.Projects.AsNoTracking().SingleAsync(p => p.Id == projectId, ct);
        return TypedResults.Ok(ToResponse(project, check.Role));
    }

    private static async Task<IResult> UpdateAsync(Guid projectId, UpdateProjectRequest request, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        List<string>? sites = null;
        if (request.LiveSites is not null)
        {
            sites = [];
            foreach (var entry in request.LiveSites)
            {
                if (!LivePageUrl.TryNormalizeOrigin(entry, out var origin))
                {
                    return TypedResults.ValidationProblem(new Dictionary<string, string[]>
                    {
                        ["liveSites"] = [$"\"{entry}\" isn't a site address. Use just the scheme and host, like https://app.example.com."],
                    });
                }

                if (!sites.Contains(origin, StringComparer.Ordinal))
                {
                    sites.Add(origin);
                }
            }

            if (sites.Count > LivePageUrl.MaxSites)
            {
                return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["liveSites"] = [$"A project can have at most {LivePageUrl.MaxSites} live sites."] });
            }
        }

        var project = await db.Projects.SingleAsync(p => p.Id == projectId, ct);
        project.Name = request.Name?.Trim() ?? project.Name;
        project.IsArchived = request.IsArchived ?? project.IsArchived;
        project.LiveSites = sites ?? project.LiveSites;

        var matchQuery = request.LiveMatchQuery ?? project.LiveMatchQuery;
        var matchHash = request.LiveMatchHash ?? project.LiveMatchHash;
        if (matchQuery != project.LiveMatchQuery || matchHash != project.LiveMatchHash)
        {
            project.LiveMatchQuery = matchQuery;
            project.LiveMatchHash = matchHash;
            await RekeyLivePagesAsync(db, projectId, matchQuery, matchHash, ct);
        }

        audit.Record(AuditActions.ProjectUpdated, project.OrganizationId, "project", projectId, request);
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(ToResponse(project, check.Role));
    }

    /// <summary>
    /// Applies new matching rules to existing live annotations. Only the original page key is stored, so loosening a rule
    /// (e.g. ignoring the query) merges pages, while tightening it leaves existing keys as they are.
    /// </summary>
    private static async Task RekeyLivePagesAsync(InklayerDbContext db, Guid projectId, bool matchQuery, bool matchHash, CancellationToken ct)
    {
        var live = await db.Annotations.Where(a => a.ProjectId == projectId && a.PageUrl != null).ToListAsync(ct);
        foreach (var annotation in live)
        {
            var key = LivePageUrl.Normalize(annotation.PageUrl, matchQuery, matchHash);
            if (key is not null && key != annotation.PageUrl)
            {
                db.Entry(annotation).Property(a => a.PageUrl).CurrentValue = key;
            }
        }
    }

    private static async Task<IResult> ListMembersAsync(Guid projectId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var rows = await db.OrganizationMembers.AsNoTracking()
            .Where(m => m.OrganizationId == check.OrganizationId)
            .Select(m => new
            {
                m.UserId,
                m.User!.Email,
                m.User.DisplayName,
                m.Role,
                Override = db.ProjectMembers.Where(pm => pm.ProjectId == projectId && pm.UserId == m.UserId).Select(pm => (Role?)pm.Role).FirstOrDefault(),
            })
            .OrderBy(m => m.DisplayName)
            .ToListAsync(ct);

        return TypedResults.Ok(rows.Select(r => new ProjectMemberResponse(
            r.UserId, r.Email, r.DisplayName, r.Role, r.Override, PermissionPolicy.EffectiveProjectRole(r.Role, r.Override))).ToList());
    }

    private static async Task<IResult> SetRoleAsync(Guid projectId, Guid userId, SetProjectRoleRequest request, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var role = request.Role!.Value;
        if (role is not (Role.Viewer or Role.Commenter or Role.Editor))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["role"] = ["A project role must be Viewer, Commenter or Editor."] });
        }

        if (!await db.OrganizationMembers.AnyAsync(m => m.OrganizationId == check.OrganizationId && m.UserId == userId, ct))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "That user isn't a member of this organisation.");
        }

        var existing = await db.ProjectMembers.SingleOrDefaultAsync(m => m.ProjectId == projectId && m.UserId == userId, ct);
        if (existing is null)
        {
            db.ProjectMembers.Add(new ProjectMember { ProjectId = projectId, UserId = userId, Role = role });
        }
        else
        {
            existing.Role = role;
        }

        audit.Record(AuditActions.ProjectRoleSet, check.OrganizationId, "project", projectId, new { userId, role });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RemoveRoleAsync(Guid projectId, Guid userId, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var existing = await db.ProjectMembers.SingleOrDefaultAsync(m => m.ProjectId == projectId && m.UserId == userId, ct);
        if (existing is null)
        {
            return TypedResults.NotFound();
        }

        db.ProjectMembers.Remove(existing);
        audit.Record(AuditActions.ProjectRoleRemoved, check.OrganizationId, "project", projectId, new { userId });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static ProjectResponse ToResponse(Project p, Role myRole) =>
        new(p.Id, p.OrganizationId, p.Name, p.IsArchived, p.CreatedAt, myRole, p.LiveSites, p.LiveMatchQuery, p.LiveMatchHash);
}
