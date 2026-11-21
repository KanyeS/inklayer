using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Api.Features.Notifications;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Access;

/// <param name="Role">The role asked for: Viewer (the default), Commenter, Editor or Manager.</param>
/// <param name="Message">Why, for whoever decides.</param>
public sealed record CreateAccessRequest(Role? Role, [property: StringLength(AccessRequest.MaxMessageLength)] string? Message);

/// <param name="Role">The role to give; leave it out to give the one asked for.</param>
public sealed record ApproveAccessRequest(Role? Role);

/// <param name="CurrentRole">The role the person already has on the item, if any (they may be asking for more).</param>
public sealed record AccessRequestResponse(
    Guid Id, AccessResourceType ResourceType, Guid ResourceId, Guid UserId, string DisplayName, string Email,
    Role Role, string Message, AccessRequestStatus Status, DateTime CreatedAt, Role? CurrentRole = null);

/// <summary>
/// Asking for access. Every member can see that a product exists; if they can't open it (or want a higher role), they ask, and
/// the product's Managers and the organisation's Admins and Owners are notified. One of them approves, which gives the role, or
/// declines; either way the person who asked is told.
/// <list type="bullet">
/// <item><c>POST /api/access/{type}/{id}/requests</c>: ask. Asking again while a request is pending updates it without notifying again.</item>
/// <item><c>GET /api/access/{type}/{id}/requests</c>: pending requests, for Managers.</item>
/// <item><c>POST /api/access/requests/{id}/approve</c> or <c>/decline</c>: decide. <c>DELETE /api/access/requests/{id}</c>: withdraw your own.</item>
/// </list>
/// </summary>
internal static class AccessRequestEndpoints
{
    public static IEndpointRouteBuilder MapAccessRequestEndpoints(this IEndpointRouteBuilder app)
    {
        var byItem = app.MapGroup("/api/access/{resourceType}/{resourceId:guid}/requests").WithTags("Access").RequireAuthorization();
        byItem.MapPost("/", CreateAsync).Produces<AccessRequestResponse>(StatusCodes.Status201Created).Produces<AccessRequestResponse>()
            .WithSummary("Ask for access to an item you can't open, or for a higher role");
        byItem.MapGet("/", ListAsync).Produces<List<AccessRequestResponse>>().WithSummary("Pending requests for this item (Managers)");

        var requests = app.MapGroup("/api/access/requests/{requestId:guid}").WithTags("Access").RequireAuthorization();
        requests.MapPost("/approve", ApproveAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Give the person the role they asked for, or the one sent");
        requests.MapPost("/decline", DeclineAsync).Produces(StatusCodes.Status204NoContent);
        requests.MapDelete("/", WithdrawAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Withdraw your own pending request");
        return app;
    }

    private static async Task<IResult> CreateAsync(
        string resourceType, Guid resourceId, CreateAccessRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db,
        AuditLog audit, NotificationService notifications, TimeProvider clock, CancellationToken ct)
    {
        // Only products can be asked for, for now.
        if (!IsProject(resourceType)
            || await db.Projects.AsNoTracking().SingleOrDefaultAsync(p => p.Id == resourceId && !p.IsArchived, ct) is not { } project)
        {
            return TypedResults.NotFound();
        }

        var caller = await access.GetCallerAsync(project.OrganizationId, ct);
        if (caller.OrganizationRole is null)
        {
            return TypedResults.NotFound();
        }

        var role = request.Role ?? Role.Viewer;
        if (!PermissionPolicy.IsGrantable(role))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["role"] = ["Ask for Viewer, Commenter, Editor or Manager."] });
        }

        var current = caller.ProjectRole(resourceId);
        if (current >= role)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: $"You already have {current} access to {project.Name}.");
        }

        var userId = currentUser.Id!.Value;
        var message = (request.Message ?? "").Trim();
        var pending = await db.AccessRequests.Include(r => r.User).SingleOrDefaultAsync(
            r => r.ResourceType == AccessResourceType.Project && r.ResourceId == resourceId && r.UserId == userId && r.Status == AccessRequestStatus.Pending, ct);
        if (pending is not null)
        {
            pending.Role = role;
            pending.Message = message;
            await db.SaveChangesAsync(ct);
            return TypedResults.Ok(ToResponse(pending, current));
        }

        var created = new AccessRequest
        {
            OrganizationId = project.OrganizationId,
            ResourceType = AccessResourceType.Project,
            ResourceId = resourceId,
            UserId = userId,
            Role = role,
            Message = message,
            CreatedAt = clock.GetUtcNow().UtcDateTime,
        };
        db.AccessRequests.Add(created);
        audit.Record(AuditActions.AccessRequested, project.OrganizationId, "project", resourceId, new { role });
        await db.SaveChangesAsync(ct);

        await notifications.AccessRequestedAsync(created, project.Name, await DecidersAsync(db, project.OrganizationId, resourceId, ct), ct);
        var user = await db.Users.AsNoTracking().SingleAsync(u => u.Id == userId, ct);
        return TypedResults.Created($"/api/access/requests/{created.Id}", new AccessRequestResponse(
            created.Id, created.ResourceType, created.ResourceId, userId, user.PreferredName ?? user.DisplayName, user.Email,
            created.Role, created.Message, created.Status, created.CreatedAt, current));
    }

    private static async Task<IResult> ListAsync(string resourceType, Guid resourceId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (!IsProject(resourceType))
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(resourceId, Permission.ManageAccess, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var pending = await db.AccessRequests.AsNoTracking().Include(r => r.User)
            .Where(r => r.ResourceType == AccessResourceType.Project && r.ResourceId == resourceId && r.Status == AccessRequestStatus.Pending)
            .OrderBy(r => r.CreatedAt)
            .ToListAsync(ct);
        var userIds = pending.Select(r => r.UserId).ToList();
        var grants = await db.AccessGrants.AsNoTracking()
            .Where(g => g.ResourceType == AccessResourceType.Project && g.ResourceId == resourceId && g.PrincipalType == AccessPrincipalType.User && userIds.Contains(g.PrincipalId))
            .ToDictionaryAsync(g => g.PrincipalId, g => g.Role, ct);
        return TypedResults.Ok(pending.Select(r => ToResponse(r, grants.TryGetValue(r.UserId, out var role) ? role : null)).ToList());
    }

    private static async Task<IResult> ApproveAsync(
        Guid requestId, ApproveAccessRequest? body, AccessService access, CurrentUser currentUser, InklayerDbContext db,
        AuditLog audit, NotificationService notifications, TimeProvider clock, CancellationToken ct)
    {
        var (request, project, denied) = await DecidableAsync(requestId, access, db, ct);
        if (denied is not null)
        {
            return denied;
        }

        var role = body?.Role ?? request!.Role;
        if (!PermissionPolicy.IsGrantable(role))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["role"] = ["The role must be Viewer, Commenter, Editor or Manager."] });
        }

        if (!await db.OrganizationMembers.AnyAsync(m => m.OrganizationId == request!.OrganizationId && m.UserId == request.UserId, ct))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "They're no longer a member of this organisation.");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var grant = await db.AccessGrants.SingleOrDefaultAsync(
            g => g.ResourceType == request!.ResourceType && g.ResourceId == request.ResourceId && g.PrincipalType == AccessPrincipalType.User && g.PrincipalId == request.UserId, ct);
        if (grant is null)
        {
            db.AccessGrants.Add(new AccessGrant
            {
                OrganizationId = request!.OrganizationId,
                ResourceType = request.ResourceType,
                ResourceId = request.ResourceId,
                PrincipalType = AccessPrincipalType.User,
                PrincipalId = request.UserId,
                Role = role,
                CreatedAt = now,
                CreatedByUserId = currentUser.Id,
            });
        }
        else if (grant.Role < role)
        {
            grant.Role = role;
        }

        Decide(request!, AccessRequestStatus.Approved, currentUser.Id!.Value, now);
        audit.Record(AuditActions.AccessRequestApproved, request!.OrganizationId, "project", request.ResourceId, new { request.UserId, role });
        await db.SaveChangesAsync(ct);
        await notifications.AccessDecidedAsync(request, project!.Name, role, currentUser.Id!.Value, ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> DeclineAsync(
        Guid requestId, AccessService access, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, NotificationService notifications, TimeProvider clock, CancellationToken ct)
    {
        var (request, project, denied) = await DecidableAsync(requestId, access, db, ct);
        if (denied is not null)
        {
            return denied;
        }

        Decide(request!, AccessRequestStatus.Declined, currentUser.Id!.Value, clock.GetUtcNow().UtcDateTime);
        audit.Record(AuditActions.AccessRequestDeclined, request!.OrganizationId, "project", request.ResourceId, new { request.UserId });
        await db.SaveChangesAsync(ct);
        await notifications.AccessDecidedAsync(request, project!.Name, null, currentUser.Id!.Value, ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> WithdrawAsync(Guid requestId, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var request = await db.AccessRequests.SingleOrDefaultAsync(r => r.Id == requestId && r.UserId == currentUser.Id, ct);
        if (request is null)
        {
            return TypedResults.NotFound();
        }

        if (request.Status != AccessRequestStatus.Pending)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This request has already been answered.");
        }

        db.AccessRequests.Remove(request);
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    /// <summary>
    /// Who decides on requests for a product: its Managers, given the role directly or through a team, and the organisation's
    /// Admins and Owners.
    /// </summary>
    internal static async Task<List<Guid>> DecidersAsync(InklayerDbContext db, Guid organizationId, Guid projectId, CancellationToken ct)
    {
        var admins = await db.OrganizationMembers
            .Where(m => m.OrganizationId == organizationId && (m.Role == Role.Admin || m.Role == Role.Owner))
            .Select(m => m.UserId)
            .ToListAsync(ct);
        var managerGrants = await db.AccessGrants
            .Where(g => g.ResourceType == AccessResourceType.Project && g.ResourceId == projectId && g.Role == Role.Manager)
            .ToListAsync(ct);
        var teamIds = managerGrants.Where(g => g.PrincipalType == AccessPrincipalType.Team).Select(g => g.PrincipalId).ToList();
        var teamMembers = await db.TeamMembers.Where(m => teamIds.Contains(m.TeamId)).Select(m => m.UserId).ToListAsync(ct);
        return [.. admins
            .Concat(managerGrants.Where(g => g.PrincipalType == AccessPrincipalType.User).Select(g => g.PrincipalId))
            .Concat(teamMembers)
            .Distinct()];
    }

    /// <summary>Loads a pending request the caller may decide on: they must be able to manage access to its item.</summary>
    private static async Task<(AccessRequest? Request, Domain.Projects.Project? Project, IResult? Denied)> DecidableAsync(
        Guid requestId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var request = await db.AccessRequests.SingleOrDefaultAsync(r => r.Id == requestId, ct);
        if (request is null)
        {
            return (null, null, TypedResults.NotFound());
        }

        var check = await access.CheckProjectAsync(request.ResourceId, Permission.ManageAccess, ct);
        if (!check.IsAllowed)
        {
            return (null, null, check.Denied);
        }

        if (request.Status != AccessRequestStatus.Pending)
        {
            return (null, null, TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: $"This request was already {request.Status.ToString().ToLowerInvariant()}."));
        }

        var project = await db.Projects.AsNoTracking().SingleAsync(p => p.Id == request.ResourceId, ct);
        return (request, project, null);
    }

    private static void Decide(AccessRequest request, AccessRequestStatus status, Guid deciderId, DateTime now)
    {
        request.Status = status;
        request.DecidedAt = now;
        request.DecidedByUserId = deciderId;
    }

    private static bool IsProject(string resourceType) =>
        Enum.TryParse<AccessResourceType>(resourceType, ignoreCase: true, out var type) && Enum.IsDefined(type) && type == AccessResourceType.Project;

    private static AccessRequestResponse ToResponse(AccessRequest r, Role? currentRole) =>
        new(r.Id, r.ResourceType, r.ResourceId, r.UserId, r.User!.PreferredName ?? r.User.DisplayName, r.User.Email,
            r.Role, r.Message, r.Status, r.CreatedAt, currentRole);
}
