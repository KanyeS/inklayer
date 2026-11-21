using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Organizations;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Access;

public sealed record TeamRequest([property: Required, StringLength(Team.MaxNameLength, MinimumLength = 1)] string Name);

/// <param name="Source">Manual teams are edited here; teams synced from single sign-on or SCIM are read-only.</param>
/// <param name="IsMember">The caller is in this team.</param>
public sealed record TeamResponse(Guid Id, Guid OrganizationId, string Name, TeamSource Source, int MemberCount, bool IsMember);

public sealed record TeamMemberResponse(Guid UserId, string Email, string DisplayName, string? AvatarUrl);

/// <summary>
/// Teams: groups of an organisation's members, given access to products, features and docs, and used as audiences.
/// Every member can see the teams; Admins create them and change who's in them.
/// </summary>
internal static class TeamEndpoints
{
    public static IEndpointRouteBuilder MapTeamEndpoints(this IEndpointRouteBuilder app)
    {
        var byOrg = app.MapGroup("/api/orgs/{orgId:guid}/teams").WithTags("Teams").RequireAuthorization();
        byOrg.MapGet("/", ListAsync).Produces<List<TeamResponse>>();
        byOrg.MapPost("/", CreateAsync).Produces<TeamResponse>(StatusCodes.Status201Created);

        var teams = app.MapGroup("/api/teams").WithTags("Teams").RequireAuthorization();
        teams.MapPatch("/{teamId:guid}", RenameAsync).Produces<TeamResponse>();
        teams.MapDelete("/{teamId:guid}", DeleteAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Delete the team and everything it was given access to");
        teams.MapGet("/{teamId:guid}/members", MembersAsync).Produces<List<TeamMemberResponse>>();
        teams.MapPut("/{teamId:guid}/members/{userId:guid}", AddMemberAsync).Produces(StatusCodes.Status204NoContent);
        teams.MapDelete("/{teamId:guid}/members/{userId:guid}", RemoveMemberAsync).Produces(StatusCodes.Status204NoContent);
        return app;
    }

    private static async Task<IResult> ListAsync(Guid orgId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var me = currentUser.Id;
        var teams = await db.Teams.AsNoTracking()
            .Where(t => t.OrganizationId == orgId)
            .Select(t => new TeamResponse(t.Id, t.OrganizationId, t.Name, t.Source, t.Members.Count, t.Members.Any(m => m.UserId == me)))
            .ToListAsync(ct);
        return TypedResults.Ok(teams.OrderBy(t => t.Name, StringComparer.OrdinalIgnoreCase).ToList());
    }

    private static async Task<IResult> CreateAsync(Guid orgId, TeamRequest request, AccessService access, InklayerDbContext db, AuditLog audit, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var name = request.Name.Trim();
        if (await NameTakenAsync(db, orgId, name, null, ct))
        {
            return NameTaken(name);
        }

        var team = new Team { OrganizationId = orgId, Name = name, CreatedAt = clock.GetUtcNow().UtcDateTime };
        db.Teams.Add(team);
        audit.Record(AuditActions.TeamCreated, orgId, "team", team.Id, new { team.Name });
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/teams/{team.Id}", new TeamResponse(team.Id, orgId, team.Name, team.Source, 0, false));
    }

    private static async Task<IResult> RenameAsync(Guid teamId, TeamRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var (team, denied) = await ManageableTeamAsync(teamId, access, db, ct);
        if (denied is not null)
        {
            return denied;
        }

        var name = request.Name.Trim();
        if (await NameTakenAsync(db, team!.OrganizationId, name, team.Id, ct))
        {
            return NameTaken(name);
        }

        team.Name = name;
        audit.Record(AuditActions.TeamUpdated, team.OrganizationId, "team", team.Id, new { team.Name });
        await db.SaveChangesAsync(ct);
        var me = currentUser.Id;
        var count = await db.TeamMembers.CountAsync(m => m.TeamId == teamId, ct);
        var isMember = await db.TeamMembers.AnyAsync(m => m.TeamId == teamId && m.UserId == me, ct);
        return TypedResults.Ok(new TeamResponse(team.Id, team.OrganizationId, team.Name, team.Source, count, isMember));
    }

    private static async Task<IResult> DeleteAsync(Guid teamId, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var (team, denied) = await ManageableTeamAsync(teamId, access, db, ct);
        if (denied is not null)
        {
            return denied;
        }

        // Grants aren't tied to their principal by a foreign key (a principal is a person or a team), so remove them here.
        await db.AccessGrants.Where(g => g.PrincipalType == AccessPrincipalType.Team && g.PrincipalId == teamId).ExecuteDeleteAsync(ct);
        db.Teams.Remove(team!);
        audit.Record(AuditActions.TeamDeleted, team!.OrganizationId, "team", team.Id, new { team.Name });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> MembersAsync(Guid teamId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var orgId = await db.Teams.Where(t => t.Id == teamId).Select(t => (Guid?)t.OrganizationId).SingleOrDefaultAsync(ct);
        if (orgId is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckOrganizationAsync(orgId.Value, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var members = await db.TeamMembers.AsNoTracking()
            .Where(m => m.TeamId == teamId)
            .Select(m => new TeamMemberResponse(m.UserId, m.User!.Email, m.User.PreferredName ?? m.User.DisplayName, m.User.AvatarUrl))
            .ToListAsync(ct);
        return TypedResults.Ok(members.OrderBy(m => m.DisplayName, StringComparer.OrdinalIgnoreCase).ToList());
    }

    private static async Task<IResult> AddMemberAsync(Guid teamId, Guid userId, AccessService access, InklayerDbContext db, AuditLog audit, TimeProvider clock, CancellationToken ct)
    {
        var (team, denied) = await ManageableTeamAsync(teamId, access, db, ct, editingMembers: true);
        if (denied is not null)
        {
            return denied;
        }

        if (!await db.OrganizationMembers.AnyAsync(m => m.OrganizationId == team!.OrganizationId && m.UserId == userId, ct))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "That person isn't a member of this organisation.");
        }

        if (!await db.TeamMembers.AnyAsync(m => m.TeamId == teamId && m.UserId == userId, ct))
        {
            db.TeamMembers.Add(new TeamMember { TeamId = teamId, UserId = userId, AddedAt = clock.GetUtcNow().UtcDateTime });
            audit.Record(AuditActions.TeamMemberAdded, team!.OrganizationId, "team", teamId, new { userId });
            await db.SaveChangesAsync(ct);
        }

        return TypedResults.NoContent();
    }

    private static async Task<IResult> RemoveMemberAsync(Guid teamId, Guid userId, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var (team, denied) = await ManageableTeamAsync(teamId, access, db, ct, editingMembers: true);
        if (denied is not null)
        {
            return denied;
        }

        var member = await db.TeamMembers.SingleOrDefaultAsync(m => m.TeamId == teamId && m.UserId == userId, ct);
        if (member is null)
        {
            return TypedResults.NotFound();
        }

        db.TeamMembers.Remove(member);
        audit.Record(AuditActions.TeamMemberRemoved, team!.OrganizationId, "team", teamId, new { userId });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    /// <summary>Loads a team the caller may change. Synced teams can be renamed or deleted, but their members come from the identity provider.</summary>
    private static async Task<(Team? Team, IResult? Denied)> ManageableTeamAsync(
        Guid teamId, AccessService access, InklayerDbContext db, CancellationToken ct, bool editingMembers = false)
    {
        var team = await db.Teams.SingleOrDefaultAsync(t => t.Id == teamId, ct);
        if (team is null)
        {
            return (null, TypedResults.NotFound());
        }

        var check = await access.CheckOrganizationAsync(team.OrganizationId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return (null, check.Denied);
        }

        if (editingMembers && team.Source != TeamSource.Manual)
        {
            return (null, TypedResults.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "This team's members come from your identity provider. Change them there."));
        }

        return (team, null);
    }

    private static async Task<bool> NameTakenAsync(InklayerDbContext db, Guid orgId, string name, Guid? except, CancellationToken ct)
    {
        var names = await db.Teams.Where(t => t.OrganizationId == orgId && t.Id != except).Select(t => t.Name).ToListAsync(ct);
        return names.Contains(name, StringComparer.OrdinalIgnoreCase);
    }

    private static IResult NameTaken(string name) =>
        TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: $"There's already a team called {name}.");
}
