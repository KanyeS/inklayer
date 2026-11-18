using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Organizations;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Organizations;

internal static class OrganizationEndpoints
{
    public static IEndpointRouteBuilder MapOrganizationEndpoints(this IEndpointRouteBuilder app)
    {
        var orgs = app.MapGroup("/api/orgs").WithTags("Organizations").RequireAuthorization();

        orgs.MapPost("/", CreateAsync).WithSummary("Create an organisation (instance administrators only); the creator becomes Owner");
        orgs.MapGet("/{orgId:guid}", GetAsync).WithName("GetOrganization");
        orgs.MapPatch("/{orgId:guid}", UpdateAsync).WithSummary("Rename, set the default role, or replace the allowed Google Workspace domains");

        orgs.MapGet("/{orgId:guid}/members", ListMembersAsync);
        orgs.MapPut("/{orgId:guid}/members/{userId:guid}", SetMemberRoleAsync);
        orgs.MapDelete("/{orgId:guid}/members/{userId:guid}", RemoveMemberAsync).WithSummary("Remove a member, or leave the organisation (your own user id)");

        orgs.MapGet("/{orgId:guid}/invitations", ListInvitationsAsync);
        orgs.MapPost("/{orgId:guid}/invitations", InviteAsync)
            .WithSummary("Allow an email address to join. They are added when they next sign in with Google using that verified address.");
        orgs.MapDelete("/{orgId:guid}/invitations/{invitationId:guid}", RevokeInvitationAsync);

        orgs.MapGet("/{orgId:guid}/audit", ListAuditAsync).WithSummary("Audit log, newest first. Page with ?before=<occurredAt>.");

        return app;
    }

    private static async Task<IResult> CreateAsync(CreateOrganizationRequest request, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, TimeProvider clock, CancellationToken ct)
    {
        var user = await currentUser.GetAsync(ct);
        if (user is not { IsSystemAdmin: true })
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only instance administrators can create organisations.");
        }

        var defaultRole = request.DefaultRole ?? Role.Viewer;
        if (!OrganizationRules.IsValidDefaultRole(defaultRole))
        {
            return InvalidDefaultRole();
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var organization = new Organization { Name = request.Name.Trim(), DefaultRole = defaultRole, CreatedAt = now };
        var domainError = await ApplyDomainsAsync(organization, request.AllowedDomains ?? [], db, ct);
        if (domainError is not null)
        {
            return domainError;
        }

        organization.Members.Add(new OrganizationMember { OrganizationId = organization.Id, UserId = user.Id, Role = Role.Owner, JoinedAt = now });
        db.Organizations.Add(organization);
        audit.Record(AuditActions.OrganizationCreated, organization.Id, "organization", organization.Id, new { organization.Name });
        await db.SaveChangesAsync(ct);

        return TypedResults.CreatedAtRoute(ToResponse(organization, Role.Owner), "GetOrganization", new { orgId = organization.Id });
    }

    private static async Task<IResult> GetAsync(Guid orgId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var organization = await db.Organizations.AsNoTracking().Include(o => o.Domains).SingleAsync(o => o.Id == orgId, ct);
        return TypedResults.Ok(ToResponse(organization, check.Role));
    }

    private static async Task<IResult> UpdateAsync(Guid orgId, UpdateOrganizationRequest request, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var organization = await db.Organizations.Include(o => o.Domains).SingleAsync(o => o.Id == orgId, ct);
        if (request.Name is not null)
        {
            organization.Name = request.Name.Trim();
        }

        if (request.DefaultRole is { } defaultRole)
        {
            if (!OrganizationRules.IsValidDefaultRole(defaultRole))
            {
                return InvalidDefaultRole();
            }

            organization.DefaultRole = defaultRole;
        }

        if (request.AllowedDomains is not null)
        {
            var domainError = await ApplyDomainsAsync(organization, request.AllowedDomains, db, ct);
            if (domainError is not null)
            {
                return domainError;
            }
        }

        audit.Record(AuditActions.OrganizationUpdated, orgId, "organization", orgId, request);
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(ToResponse(organization, check.Role));
    }

    private static async Task<IResult> ListMembersAsync(Guid orgId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var members = await db.OrganizationMembers.AsNoTracking()
            .Where(m => m.OrganizationId == orgId)
            .OrderBy(m => m.User!.DisplayName)
            .Select(m => new MemberResponse(m.UserId, m.User!.Email, m.User.DisplayName, m.User.AvatarUrl, m.Role, m.JoinedAt))
            .ToListAsync(ct);
        return TypedResults.Ok(members);
    }

    private static async Task<IResult> SetMemberRoleAsync(Guid orgId, Guid userId, SetRoleRequest request, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var member = await db.OrganizationMembers.SingleOrDefaultAsync(m => m.OrganizationId == orgId && m.UserId == userId, ct);
        if (member is null)
        {
            return TypedResults.NotFound();
        }

        var newRole = request.Role!.Value;
        if ((member.Role == Role.Owner || newRole == Role.Owner) && !check.Role.Grants(Permission.ManageOwners))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only Owners can grant or remove the Owner role.");
        }

        if (member.Role == Role.Owner && newRole != Role.Owner && await IsLastOwnerAsync(orgId, db, ct))
        {
            return LastOwner();
        }

        var previous = member.Role;
        member.Role = newRole;
        audit.Record(AuditActions.MemberRoleChanged, orgId, "user", userId, new { from = previous, to = newRole });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RemoveMemberAsync(Guid orgId, Guid userId, AccessService access, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var isSelf = currentUser.Id == userId;
        var check = await access.CheckOrganizationAsync(orgId, isSelf ? Permission.View : Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var member = await db.OrganizationMembers.SingleOrDefaultAsync(m => m.OrganizationId == orgId && m.UserId == userId, ct);
        if (member is null)
        {
            return TypedResults.NotFound();
        }

        if (member.Role == Role.Owner)
        {
            if (!isSelf && !check.Role.Grants(Permission.ManageOwners))
            {
                return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only Owners can remove an Owner.");
            }

            if (await IsLastOwnerAsync(orgId, db, ct))
            {
                return LastOwner();
            }
        }

        db.OrganizationMembers.Remove(member);
        await db.ProjectMembers
            .Where(pm => pm.UserId == userId && db.Projects.Any(p => p.Id == pm.ProjectId && p.OrganizationId == orgId))
            .ExecuteDeleteAsync(ct);
        audit.Record(AuditActions.MemberRemoved, orgId, "user", userId, new { member.Role, self = isSelf });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ListInvitationsAsync(Guid orgId, AccessService access, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var invitations = await db.Invitations.AsNoTracking()
            .Where(i => i.OrganizationId == orgId && i.AcceptedAt == null && i.ExpiresAt > now)
            .OrderBy(i => i.Email)
            .Select(i => new InvitationResponse(i.Id, i.Email, i.Role, i.CreatedAt, i.ExpiresAt))
            .ToListAsync(ct);
        return TypedResults.Ok(invitations);
    }

    private static async Task<IResult> InviteAsync(
        Guid orgId, CreateInvitationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, AuditLog audit,
        TimeProvider clock, IOptions<Auth.InklayerAuthOptions> options, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var role = request.Role!.Value;
        if (role == Role.Owner && !check.Role.Grants(Permission.ManageOwners))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only Owners can invite Owners.");
        }

        var email = request.Email.Trim().ToLowerInvariant();
        var alreadyMember = await db.OrganizationMembers.AnyAsync(m => m.OrganizationId == orgId && m.User!.Email == email, ct);
        if (alreadyMember)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "That person is already a member.");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var expiresAt = now.AddDays(options.Value.InvitationLifetimeDays);
        var invitation = await db.Invitations.SingleOrDefaultAsync(i => i.OrganizationId == orgId && i.Email == email && i.AcceptedAt == null, ct);
        var created = invitation is null;
        if (invitation is null)
        {
            invitation = new Invitation { OrganizationId = orgId, Email = email, Role = role, InvitedByUserId = currentUser.Id!.Value, CreatedAt = now, ExpiresAt = expiresAt };
            db.Invitations.Add(invitation);
        }
        else
        {
            invitation.Role = role;
            invitation.ExpiresAt = expiresAt;
        }

        audit.Record(AuditActions.InvitationCreated, orgId, "invitation", invitation.Id, new { email, role });
        await db.SaveChangesAsync(ct);

        var response = new InvitationResponse(invitation.Id, invitation.Email, invitation.Role, invitation.CreatedAt, invitation.ExpiresAt);
        return created ? TypedResults.Created($"/api/orgs/{orgId}/invitations/{invitation.Id}", response) : TypedResults.Ok(response);
    }

    private static async Task<IResult> RevokeInvitationAsync(Guid orgId, Guid invitationId, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var invitation = await db.Invitations.SingleOrDefaultAsync(i => i.Id == invitationId && i.OrganizationId == orgId && i.AcceptedAt == null, ct);
        if (invitation is null)
        {
            return TypedResults.NotFound();
        }

        db.Invitations.Remove(invitation);
        audit.Record(AuditActions.InvitationRevoked, orgId, "invitation", invitationId, new { invitation.Email });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ListAuditAsync(Guid orgId, DateTime? before, int? limit, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageMembers, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var take = Math.Clamp(limit ?? 50, 1, 200);
        var query = db.AuditEvents.AsNoTracking().Where(e => e.OrganizationId == orgId);
        if (before is { } cursor)
        {
            var utc = cursor.Kind == DateTimeKind.Utc ? cursor : cursor.ToUniversalTime();
            query = query.Where(e => e.OccurredAt < utc);
        }

        var events = await query
            .OrderByDescending(e => e.OccurredAt).ThenByDescending(e => e.Id)
            .Take(take)
            .Select(e => new AuditEventResponse(
                e.Id, e.OccurredAt, e.ActorUserId,
                db.Users.Where(u => u.Id == e.ActorUserId).Select(u => u.Email).FirstOrDefault(),
                e.Action, e.TargetType, e.TargetId, e.Data, e.IpAddress))
            .ToListAsync(ct);
        return TypedResults.Ok(events);
    }

    private static async Task<IResult?> ApplyDomainsAsync(Organization organization, IReadOnlyList<string> domains, InklayerDbContext db, CancellationToken ct)
    {
        var normalized = domains.Select(OrganizationRules.NormalizeDomain).Distinct(StringComparer.Ordinal).ToList();
        var invalid = normalized.Where(d => !OrganizationRules.IsValidDomain(d)).ToList();
        if (invalid.Count > 0)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["allowedDomains"] = [$"Not a valid domain: {string.Join(", ", invalid)}"] });
        }

        var takenElsewhere = await db.OrganizationDomains
            .Where(d => normalized.Contains(d.Domain) && d.OrganizationId != organization.Id)
            .Select(d => d.Domain)
            .ToListAsync(ct);
        if (takenElsewhere.Count > 0)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: $"Already used by another organisation: {string.Join(", ", takenElsewhere)}");
        }

        organization.Domains.RemoveAll(d => !normalized.Contains(d.Domain));
        foreach (var domain in normalized.Where(d => organization.Domains.TrueForAll(existing => existing.Domain != d)))
        {
            organization.Domains.Add(new OrganizationDomain { OrganizationId = organization.Id, Domain = domain });
        }

        return null;
    }

    private static async Task<bool> IsLastOwnerAsync(Guid orgId, InklayerDbContext db, CancellationToken ct) =>
        await db.OrganizationMembers.CountAsync(m => m.OrganizationId == orgId && m.Role == Role.Owner, ct) <= 1;

    private static OrganizationResponse ToResponse(Organization o, Role myRole) =>
        new(o.Id, o.Name, o.DefaultRole, [.. o.Domains.Select(d => d.Domain).Order(StringComparer.Ordinal)], o.CreatedAt, myRole);

    private static Microsoft.AspNetCore.Http.HttpResults.ProblemHttpResult LastOwner() =>
        TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "An organisation must keep at least one Owner.");

    private static Microsoft.AspNetCore.Http.HttpResults.ValidationProblem InvalidDefaultRole() =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["defaultRole"] = ["The default role must be Viewer, Commenter or Editor."] });
}
