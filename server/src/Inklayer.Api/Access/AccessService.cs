using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Access;

/// <summary>The outcome of an access check. When <see cref="Denied"/> is set, return it from the endpoint as-is.</summary>
public sealed record AccessResult(Role Role, Guid OrganizationId, IResult? Denied)
{
    public bool IsAllowed => Denied is null;

    public static AccessResult NotFound() => new(default, default, TypedResults.NotFound());

    public static AccessResult Forbidden(Role role, Guid organizationId) =>
        new(role, organizationId, TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Your role doesn't allow this."));
}

/// <summary>
/// Resolves the caller's role in an organisation or project and checks it against a <see cref="Permission"/>.
/// <list type="bullet">
/// <item>Non-members get 404, so other organisations' resources can't be discovered.</item>
/// <item>Members whose role is too low get 403.</item>
/// <item>Instance administrators act as Owner everywhere.</item>
/// </list>
/// </summary>
public sealed class AccessService(InklayerDbContext db, CurrentUser currentUser)
{
    public async Task<Role?> GetOrganizationRoleAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        var user = await currentUser.GetAsync(cancellationToken);
        if (user is null || user.IsDisabled)
        {
            return null;
        }

        if (user.IsSystemAdmin)
        {
            return await db.Organizations.AnyAsync(o => o.Id == organizationId, cancellationToken) ? Role.Owner : null;
        }

        return await db.OrganizationMembers
            .Where(m => m.OrganizationId == organizationId && m.UserId == user.Id)
            .Select(m => (Role?)m.Role)
            .SingleOrDefaultAsync(cancellationToken);
    }

    public async Task<AccessResult> CheckOrganizationAsync(Guid organizationId, Permission permission, CancellationToken cancellationToken)
    {
        var role = await GetOrganizationRoleAsync(organizationId, cancellationToken);
        if (role is null)
        {
            return AccessResult.NotFound();
        }

        return role.Value.Grants(permission)
            ? new AccessResult(role.Value, organizationId, null)
            : AccessResult.Forbidden(role.Value, organizationId);
    }

    public async Task<AccessResult> CheckProjectAsync(Guid projectId, Permission permission, CancellationToken cancellationToken)
    {
        var organizationId = await db.Projects.Where(p => p.Id == projectId).Select(p => (Guid?)p.OrganizationId).SingleOrDefaultAsync(cancellationToken);
        if (organizationId is null)
        {
            return AccessResult.NotFound();
        }

        var orgRole = await GetOrganizationRoleAsync(organizationId.Value, cancellationToken);
        if (orgRole is null)
        {
            return AccessResult.NotFound();
        }

        var userId = currentUser.Id!.Value;
        var projectOverride = await db.ProjectMembers
            .Where(m => m.ProjectId == projectId && m.UserId == userId)
            .Select(m => (Role?)m.Role)
            .SingleOrDefaultAsync(cancellationToken);

        var role = PermissionPolicy.EffectiveProjectRole(orgRole.Value, projectOverride);
        return role.Grants(permission)
            ? new AccessResult(role, organizationId.Value, null)
            : AccessResult.Forbidden(role, organizationId.Value);
    }

    /// <summary>For listing projects: the effective role in every project of an organisation, given the caller's organisation role.</summary>
    public async Task<Dictionary<Guid, Role>> GetProjectOverridesAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        var userId = currentUser.Id!.Value;
        return await db.ProjectMembers
            .Where(m => m.UserId == userId && db.Projects.Any(p => p.Id == m.ProjectId && p.OrganizationId == organizationId))
            .ToDictionaryAsync(m => m.ProjectId, m => m.Role, cancellationToken);
    }
}
