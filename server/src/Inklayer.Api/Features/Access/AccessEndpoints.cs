using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Access;

public sealed record SetGrantRequest([property: Required] Role? Role);

/// <param name="Name">The team's name, or the person's display name.</param>
/// <param name="Email">For people only.</param>
public sealed record GrantResponse(AccessPrincipalType PrincipalType, Guid PrincipalId, string Name, string? Email, Role Role);

/// <param name="MyRole">The caller's role on the item.</param>
/// <param name="CanManage">The caller can change who has access (Manager, or an organisation Admin or Owner).</param>
public sealed record AccessResponse(AccessResourceType ResourceType, Guid ResourceId, Role MyRole, bool CanManage, IReadOnlyList<GrantResponse> Grants);

/// <summary>One person who can reach the item, their role, and why.</summary>
/// <param name="Via">The reasons, e.g. <c>Organisation Admin</c>, <c>Given directly</c> or <c>Team: Support</c>. The highest role wins.</param>
public sealed record AccessPersonResponse(Guid UserId, string Email, string DisplayName, Role Role, IReadOnlyList<string> Via);

/// <summary>
/// Who has access to a product, feature or doc. <c>{resourceType}</c> is <c>project</c> (a product), <c>feature</c> or <c>doc</c>.
/// <list type="bullet">
/// <item><c>GET</c>: the grants on the item. Anyone who can see the item can read them.</item>
/// <item><c>PUT/DELETE .../{principalType}/{principalId}</c>: give or take away a person's or team's role. Managers only.</item>
/// <item><c>GET .../people</c>: everyone who can reach the item and why, for "who can see this?".</item>
/// </list>
/// </summary>
internal static class AccessEndpoints
{
    public static IEndpointRouteBuilder MapAccessEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/access/{resourceType}/{resourceId:guid}").WithTags("Access").RequireAuthorization();
        group.MapGet("/", GetAsync).Produces<AccessResponse>();
        group.MapGet("/people", PeopleAsync).Produces<List<AccessPersonResponse>>().WithSummary("Everyone who can reach this item, with their role and why");
        group.MapPut("/{principalType}/{principalId:guid}", SetAsync).Produces(StatusCodes.Status204NoContent)
            .WithSummary("Give a person or team a role on this item: Viewer, Commenter, Editor or Manager");
        group.MapDelete("/{principalType}/{principalId:guid}", RemoveAsync).Produces(StatusCodes.Status204NoContent);
        return app;
    }

    private static async Task<IResult> GetAsync(string resourceType, Guid resourceId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await CheckAsync(resourceType, resourceId, Permission.View, access, ct) is not { } found)
        {
            return TypedResults.NotFound();
        }

        if (!found.Check.IsAllowed)
        {
            return found.Check.Denied!;
        }

        var grants = await db.AccessGrants.AsNoTracking()
            .Where(g => g.ResourceType == found.Type && g.ResourceId == resourceId)
            .ToListAsync(ct);
        var userIds = grants.Where(g => g.PrincipalType == AccessPrincipalType.User).Select(g => g.PrincipalId).ToList();
        var teamIds = grants.Where(g => g.PrincipalType == AccessPrincipalType.Team).Select(g => g.PrincipalId).ToList();
        var users = await db.Users.Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => (Name: u.PreferredName ?? u.DisplayName, u.Email), ct);
        var teams = await db.Teams.Where(t => teamIds.Contains(t.Id)).ToDictionaryAsync(t => t.Id, t => t.Name, ct);

        var rows = grants
            .Select(g => g.PrincipalType == AccessPrincipalType.Team
                ? new GrantResponse(g.PrincipalType, g.PrincipalId, teams.GetValueOrDefault(g.PrincipalId, "(deleted team)"), null, g.Role)
                : new GrantResponse(g.PrincipalType, g.PrincipalId, users.TryGetValue(g.PrincipalId, out var u) ? u.Name : "(deleted user)", users.TryGetValue(g.PrincipalId, out var e) ? e.Email : null, g.Role))
            .OrderBy(g => g.PrincipalType).ThenBy(g => g.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

        var myRole = found.Check.Role;
        return TypedResults.Ok(new AccessResponse(found.Type, resourceId, myRole, myRole.Grants(Permission.ManageAccess), rows));
    }

    private static async Task<IResult> PeopleAsync(string resourceType, Guid resourceId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await CheckAsync(resourceType, resourceId, Permission.View, access, ct) is not { } found)
        {
            return TypedResults.NotFound();
        }

        if (!found.Check.IsAllowed)
        {
            return found.Check.Denied!;
        }

        var orgId = found.Check.OrganizationId;
        var members = await db.OrganizationMembers.AsNoTracking()
            .Where(m => m.OrganizationId == orgId && !m.User!.IsDisabled)
            .Select(m => new { m.UserId, m.User!.Email, Name = m.User.PreferredName ?? m.User.DisplayName, m.Role })
            .ToListAsync(ct);
        var teams = await db.Teams.AsNoTracking().Where(t => t.OrganizationId == orgId).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var teamIds = teams.Keys.ToList();
        var teamsByUser = (await db.TeamMembers.AsNoTracking().Where(m => teamIds.Contains(m.TeamId)).ToListAsync(ct))
            .ToLookup(m => m.UserId, m => m.TeamId);
        var grants = await db.AccessGrants.AsNoTracking()
            .Where(g => g.ResourceType == found.Type && g.ResourceId == resourceId)
            .ToListAsync(ct);

        var people = new List<AccessPersonResponse>();
        foreach (var member in members)
        {
            if (member.Role >= Role.Admin)
            {
                people.Add(new AccessPersonResponse(member.UserId, member.Email, member.Name, member.Role, [$"Organisation {member.Role}"]));
                continue;
            }

            var myTeams = teamsByUser[member.UserId].ToHashSet();
            var reasons = grants
                .Where(g => (g.PrincipalType == AccessPrincipalType.User && g.PrincipalId == member.UserId)
                    || (g.PrincipalType == AccessPrincipalType.Team && myTeams.Contains(g.PrincipalId)))
                .Select(g => (g.Role, Why: g.PrincipalType == AccessPrincipalType.User ? "Given directly" : $"Team: {teams[g.PrincipalId]}"))
                .OrderByDescending(r => r.Role)
                .ToList();
            if (reasons.Count > 0)
            {
                people.Add(new AccessPersonResponse(member.UserId, member.Email, member.Name, reasons[0].Role, reasons.Select(r => $"{r.Why} ({r.Role})").ToList()));
            }
        }

        return TypedResults.Ok(people.OrderByDescending(p => p.Role).ThenBy(p => p.DisplayName, StringComparer.OrdinalIgnoreCase).ToList());
    }

    private static async Task<IResult> SetAsync(
        string resourceType, Guid resourceId, string principalType, Guid principalId, SetGrantRequest request,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, TimeProvider clock, CancellationToken ct)
    {
        if (await CheckAsync(resourceType, resourceId, Permission.ManageAccess, access, ct) is not { } found
            || !Enum.TryParse<AccessPrincipalType>(principalType, ignoreCase: true, out var kind) || !Enum.IsDefined(kind))
        {
            return TypedResults.NotFound();
        }

        if (!found.Check.IsAllowed)
        {
            return found.Check.Denied!;
        }

        var role = request.Role!.Value;
        if (!PermissionPolicy.IsGrantable(role))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["role"] = ["The role must be Viewer, Commenter, Editor or Manager."] });
        }

        var orgId = found.Check.OrganizationId;
        var principalExists = kind == AccessPrincipalType.Team
            ? await db.Teams.AnyAsync(t => t.Id == principalId && t.OrganizationId == orgId, ct)
            : await db.OrganizationMembers.AnyAsync(m => m.UserId == principalId && m.OrganizationId == orgId, ct);
        if (!principalExists)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: kind == AccessPrincipalType.Team
                ? "That team isn't in this organisation."
                : "That person isn't a member of this organisation.");
        }

        var grant = await db.AccessGrants.SingleOrDefaultAsync(
            g => g.ResourceType == found.Type && g.ResourceId == resourceId && g.PrincipalType == kind && g.PrincipalId == principalId, ct);
        if (grant is null)
        {
            db.AccessGrants.Add(new AccessGrant
            {
                OrganizationId = orgId,
                ResourceType = found.Type,
                ResourceId = resourceId,
                PrincipalType = kind,
                PrincipalId = principalId,
                Role = role,
                CreatedAt = clock.GetUtcNow().UtcDateTime,
                CreatedByUserId = currentUser.Id,
            });
        }
        else
        {
            grant.Role = role;
        }

        audit.Record(AuditActions.AccessGranted, orgId, found.Type.ToString().ToLowerInvariant(), resourceId, new { principalType = kind, principalId, role });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RemoveAsync(
        string resourceType, Guid resourceId, string principalType, Guid principalId, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        if (await CheckAsync(resourceType, resourceId, Permission.ManageAccess, access, ct) is not { } found
            || !Enum.TryParse<AccessPrincipalType>(principalType, ignoreCase: true, out var kind) || !Enum.IsDefined(kind))
        {
            return TypedResults.NotFound();
        }

        if (!found.Check.IsAllowed)
        {
            return found.Check.Denied!;
        }

        var grant = await db.AccessGrants.SingleOrDefaultAsync(
            g => g.ResourceType == found.Type && g.ResourceId == resourceId && g.PrincipalType == kind && g.PrincipalId == principalId, ct);
        if (grant is null)
        {
            return TypedResults.NotFound();
        }

        db.AccessGrants.Remove(grant);
        audit.Record(AuditActions.AccessRevoked, found.Check.OrganizationId, found.Type.ToString().ToLowerInvariant(), resourceId, new { principalType = kind, principalId });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    /// <summary>Checks the caller against an item, or returns null if the resource type isn't one access can be given on.</summary>
    private static async Task<(AccessResourceType Type, AccessResult Check)?> CheckAsync(
        string resourceType, Guid resourceId, Permission permission, AccessService access, CancellationToken ct)
    {
        if (!Enum.TryParse<AccessResourceType>(resourceType, ignoreCase: true, out var type) || !Enum.IsDefined(type))
        {
            return null;
        }

        // Features and docs get their own checks when they become things access is given on.
        return type switch
        {
            AccessResourceType.Project => (type, await access.CheckProjectAsync(resourceId, permission, ct)),
            _ => null,
        };
    }
}
