using Inklayer.Domain.Authorization;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Users;
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

/// <summary>What one person can reach in one organisation: their organisation role, their teams and every grant to them or their teams.</summary>
public sealed class CallerAccess(Role? organizationRole, IReadOnlySet<Guid> teamIds, IReadOnlyList<AccessGrant> grants)
{
    public Role? OrganizationRole { get; } = organizationRole;

    public IReadOnlySet<Guid> TeamIds { get; } = teamIds;

    public IReadOnlyList<AccessGrant> Grants { get; } = grants;

    /// <summary>The roles granted to the caller (directly or through a team) on one item.</summary>
    public IReadOnlyCollection<Role> RolesOn(AccessResourceType type, Guid id) =>
        Grants.Where(g => g.ResourceType == type && g.ResourceId == id).Select(g => g.Role).ToList();

    public Role? ProjectRole(Guid projectId) =>
        AccessPolicy.Resolve(OrganizationRole, [new AccessLevel(RolesOn(AccessResourceType.Project, projectId))]);
}

/// <summary>
/// Resolves the caller's role in an organisation or an item in it, and checks it against a <see cref="Permission"/>.
/// <list type="bullet">
/// <item>Non-members, and members with no access to an item, get 404, so resources they can't use can't be discovered.</item>
/// <item>Members whose role is too low get 403.</item>
/// <item>Instance administrators act as Owner everywhere.</item>
/// </list>
/// The rule itself is <see cref="AccessPolicy"/>.
/// </summary>
public sealed class AccessService(InklayerDbContext db, CurrentUser currentUser)
{
    private readonly Dictionary<Guid, CallerAccess> _callers = [];

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

    /// <summary>The caller's organisation role, teams and grants in <paramref name="organizationId"/>, loaded once per request.</summary>
    public async Task<CallerAccess> GetCallerAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        if (_callers.TryGetValue(organizationId, out var cached))
        {
            return cached;
        }

        var orgRole = await GetOrganizationRoleAsync(organizationId, cancellationToken);
        CallerAccess caller;
        if (orgRole is null || currentUser.Id is not { } userId)
        {
            caller = new CallerAccess(null, new HashSet<Guid>(), []);
        }
        else
        {
            var teamIds = await TeamIdsAsync(db, userId, [organizationId], cancellationToken);
            caller = new CallerAccess(orgRole, teamIds, await GrantsAsync(db, userId, teamIds, [organizationId], cancellationToken));
        }

        _callers[organizationId] = caller;
        return caller;
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

        var caller = await GetCallerAsync(organizationId.Value, cancellationToken);
        if (caller.ProjectRole(projectId) is not { } role)
        {
            return AccessResult.NotFound();
        }

        return role.Grants(permission)
            ? new AccessResult(role, organizationId.Value, null)
            : AccessResult.Forbidden(role, organizationId.Value);
    }

    /// <summary>The caller's role in every product of an organisation they can see. Products they can't see are left out.</summary>
    public async Task<Dictionary<Guid, Role>> GetProjectRolesAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        var caller = await GetCallerAsync(organizationId, cancellationToken);
        if (caller.OrganizationRole is null)
        {
            return [];
        }

        var projectIds = await db.Projects.Where(p => p.OrganizationId == organizationId).Select(p => p.Id).ToListAsync(cancellationToken);
        return projectIds
            .Select(id => (Id: id, Role: caller.ProjectRole(id)))
            .Where(x => x.Role is not null)
            .ToDictionary(x => x.Id, x => x.Role!.Value);
    }

    /// <summary>The items in an organisation the caller has asked for access to and is still waiting on.</summary>
    public async Task<HashSet<Guid>> GetPendingRequestsAsync(Guid organizationId, CancellationToken cancellationToken)
    {
        var userId = currentUser.Id;
        return userId is null ? [] : (await db.AccessRequests
            .Where(r => r.OrganizationId == organizationId && r.UserId == userId && r.Status == AccessRequestStatus.Pending)
            .Select(r => r.ResourceId)
            .ToListAsync(cancellationToken)).ToHashSet();
    }

    /// <summary>Every non-archived product <paramref name="user"/> can view, in every organisation, with their role.</summary>
    internal static async Task<List<(Project Project, Role Role, string OrganizationName)>> VisibleProjectsAsync(User user, InklayerDbContext db, CancellationToken ct)
    {
        var orgRoles = user.IsSystemAdmin
            ? await db.Organizations.ToDictionaryAsync(o => o.Id, _ => Role.Owner, ct)
            : await db.OrganizationMembers.Where(m => m.UserId == user.Id).ToDictionaryAsync(m => m.OrganizationId, m => m.Role, ct);
        var orgIds = orgRoles.Keys.ToList();
        var orgNames = await db.Organizations.Where(o => orgIds.Contains(o.Id)).ToDictionaryAsync(o => o.Id, o => o.Name, ct);
        var teamIds = await TeamIdsAsync(db, user.Id, orgIds, ct);
        var grants = (await GrantsAsync(db, user.Id, teamIds, orgIds, ct))
            .Where(g => g.ResourceType == AccessResourceType.Project)
            .ToLookup(g => g.ResourceId, g => g.Role);
        var projects = await db.Projects.AsNoTracking()
            .Where(p => !p.IsArchived && orgIds.Contains(p.OrganizationId))
            .ToListAsync(ct);

        return projects
            .Select(p => (Project: p, Role: AccessPolicy.Resolve(orgRoles[p.OrganizationId], [new AccessLevel(grants[p.Id].ToList())]), OrganizationName: orgNames.GetValueOrDefault(p.OrganizationId, "")))
            .Where(x => x.Role is { } r && r.Grants(Permission.View))
            .Select(x => (x.Project, x.Role!.Value, x.OrganizationName))
            .OrderBy(x => x.OrganizationName, StringComparer.OrdinalIgnoreCase).ThenBy(x => x.Project.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    internal static async Task<HashSet<Guid>> TeamIdsAsync(InklayerDbContext db, Guid userId, IReadOnlyCollection<Guid> organizationIds, CancellationToken ct) =>
        (await db.TeamMembers
            .Where(m => m.UserId == userId && db.Teams.Any(t => t.Id == m.TeamId && organizationIds.Contains(t.OrganizationId)))
            .Select(m => m.TeamId)
            .ToListAsync(ct)).ToHashSet();

    internal static async Task<List<AccessGrant>> GrantsAsync(InklayerDbContext db, Guid userId, IReadOnlySet<Guid> teamIds, IReadOnlyCollection<Guid> organizationIds, CancellationToken ct)
    {
        var teams = teamIds.ToList();
        return await db.AccessGrants.AsNoTracking()
            .Where(g => organizationIds.Contains(g.OrganizationId)
                && ((g.PrincipalType == AccessPrincipalType.User && g.PrincipalId == userId)
                    || (g.PrincipalType == AccessPrincipalType.Team && teams.Contains(g.PrincipalId))))
            .ToListAsync(ct);
    }
}
