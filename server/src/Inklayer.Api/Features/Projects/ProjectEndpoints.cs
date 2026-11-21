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

/// <summary>Only the fields that are present change.</summary>
public sealed record UpdateProjectRequest(
    [property: StringLength(200, MinimumLength = 1)] string? Name,
    bool? IsArchived);

/// <param name="MyRole">The caller's role in the product, or null if they can't open it (they can ask for access).</param>
/// <param name="AccessRequested">The caller has asked for access and is waiting for an answer.</param>
public sealed record ProjectResponse(
    Guid Id, Guid OrganizationId, string Name, bool IsArchived, DateTime CreatedAt, Role? MyRole, bool AccessRequested = false);

internal static class ProjectEndpoints
{
    public static IEndpointRouteBuilder MapProjectEndpoints(this IEndpointRouteBuilder app)
    {
        var byOrg = app.MapGroup("/api/orgs/{orgId:guid}/projects").WithTags("Projects").RequireAuthorization();
        byOrg.MapGet("/", ListAsync).Produces<List<ProjectResponse>>();
        byOrg.MapPost("/", CreateAsync).Produces<ProjectResponse>(StatusCodes.Status201Created);

        var projects = app.MapGroup("/api/projects").WithTags("Projects").RequireAuthorization();
        projects.MapGet("/{projectId:guid}", GetAsync).Produces<ProjectResponse>().WithName("GetProject");
        projects.MapPatch("/{projectId:guid}", UpdateAsync).Produces<ProjectResponse>();

        return app;
    }

    internal static async Task<IResult> ListAsync(Guid orgId, bool? includeArchived, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        // Every member sees every product's name, so they know what exists and can ask for access. What's inside a product
        // stays closed until they have a role in it.
        var roles = await access.GetProjectRolesAsync(orgId, ct);
        var requested = await access.GetPendingRequestsAsync(orgId, ct);
        var projects = await db.Projects.AsNoTracking()
            .Where(p => p.OrganizationId == orgId && (includeArchived == true || !p.IsArchived))
            .OrderBy(p => p.Name)
            .ToListAsync(ct);

        return TypedResults.Ok(projects
            .Select(p => roles.TryGetValue(p.Id, out var role) ? ToResponse(p, role) : ToResponse(p, null, requested.Contains(p.Id)))
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

    /// <summary>The product, for its members. Other members of the organisation get its name only, with no role, so they can ask for access.</summary>
    private static async Task<IResult> GetAsync(Guid projectId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var project = await db.Projects.AsNoTracking().SingleOrDefaultAsync(p => p.Id == projectId, ct);
        var caller = project is null ? null : await access.GetCallerAsync(project.OrganizationId, ct);
        if (project is null || caller?.OrganizationRole is null)
        {
            return TypedResults.NotFound();
        }

        return caller.ProjectRole(projectId) is { } role
            ? TypedResults.Ok(ToResponse(project, role))
            : TypedResults.Ok(ToResponse(project, null, (await access.GetPendingRequestsAsync(project.OrganizationId, ct)).Contains(projectId)));
    }

    private static async Task<IResult> UpdateAsync(Guid projectId, UpdateProjectRequest request, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.ManageAccess, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var project = await db.Projects.SingleAsync(p => p.Id == projectId, ct);
        project.Name = request.Name?.Trim() ?? project.Name;
        project.IsArchived = request.IsArchived ?? project.IsArchived;

        audit.Record(AuditActions.ProjectUpdated, project.OrganizationId, "project", projectId, request);
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(ToResponse(project, check.Role));
    }

    private static ProjectResponse ToResponse(Project p, Role? myRole, bool accessRequested = false) =>
        new(p.Id, p.OrganizationId, p.Name, p.IsArchived, p.CreatedAt, myRole, accessRequested);
}
