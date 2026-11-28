using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Docs;

/// <param name="CanEdit">Whether the other organisation's Commenters and above edit the text, or everyone there only reads it.</param>
public sealed record ShareDocWithOrganizationRequest(bool CanEdit);

/// <summary>
/// Sharing a doc with another organisation (see <see cref="DocOrgShare"/>). It's one doc either way: the other organisation
/// opens the same live document, so the two never get out of step.
/// <list type="bullet">
/// <item>Share or change: Commenters and above in the doc's own organisation, with another organisation where they're Commenter or above too.</item>
/// <item>Stop sharing: the same people, or an Admin of the organisation it's shared with.</item>
/// </list>
/// </summary>
internal static class DocOrgShareEndpoints
{
    public static void Map(RouteGroupBuilder docs)
    {
        docs.MapPut("/{docId:guid}/organizations/{orgId:guid}", ShareAsync).Produces(StatusCodes.Status204NoContent)
            .WithSummary("Share the doc with another organisation you're in, or change whether it can edit the text");
        docs.MapDelete("/{docId:guid}/organizations/{orgId:guid}", UnshareAsync).Produces(StatusCodes.Status204NoContent)
            .WithSummary("Stop sharing the doc with an organisation");
    }

    internal static async Task<IResult> ShareAsync(
        Guid docId, Guid orgId, ShareDocWithOrganizationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, AuditLog audit,
        TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckDocHomeAsync(docId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var homeId = check.Access!.OrganizationId;
        if (orgId == homeId)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["organizationId"] = ["The doc is already in this organisation."] });
        }

        // Only into an organisation where they could create docs themselves; others aren't revealed.
        var target = await access.CheckOrganizationAsync(orgId, Permission.Comment, ct);
        if (target.Denied is not null)
        {
            return target.Role == default ? target.Denied : TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden,
                title: "You can share a doc only with organisations where you're Commenter or above.");
        }

        var userId = currentUser.Id!.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        var share = await db.DocOrgShares.SingleOrDefaultAsync(s => s.DocId == docId && s.OrganizationId == orgId, ct);
        if (share is null)
        {
            db.DocOrgShares.Add(new DocOrgShare { DocId = docId, OrganizationId = orgId, CanEdit = request.CanEdit, SharedByUserId = userId, SharedAt = now });
        }
        else if (share.CanEdit != request.CanEdit)
        {
            share.CanEdit = request.CanEdit;
            share.SharedByUserId = userId;
            share.SharedAt = now;
        }
        else
        {
            return TypedResults.NoContent();
        }

        // In both organisations' logs: each sees what left or entered it.
        audit.Record(AuditActions.DocSharedWithOrganization, homeId, "doc", docId, new { organizationId = orgId, request.CanEdit });
        audit.Record(AuditActions.DocSharedWithOrganization, orgId, "doc", docId, new { fromOrganizationId = homeId, request.CanEdit });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    internal static async Task<IResult> UnshareAsync(Guid docId, Guid orgId, AccessService access, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var check = await access.CheckDocAsync(docId, Permission.View, ct);
        if (check.Access is null)
        {
            return check.Denied!;
        }

        var share = await db.DocOrgShares.SingleOrDefaultAsync(s => s.DocId == docId && s.OrganizationId == orgId, ct);
        if (share is null)
        {
            return TypedResults.NotFound();
        }

        var home = check.Access.HomeRole is { } homeRole && homeRole.Grants(Permission.Comment);
        var theirAdmin = await access.GetOrganizationRoleAsync(orgId, ct) is { } role && role.Grants(Permission.ManageMembers);
        if (!home && !theirAdmin)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden,
                title: "Only Commenters and above in the doc's own organisation, or an Admin of the organisation it's shared with, can stop sharing it.");
        }

        db.DocOrgShares.Remove(share);
        audit.Record(AuditActions.DocUnsharedWithOrganization, check.Access.OrganizationId, "doc", docId, new { organizationId = orgId });
        audit.Record(AuditActions.DocUnsharedWithOrganization, orgId, "doc", docId, new { fromOrganizationId = check.Access.OrganizationId });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    /// <summary>The organisations a doc is shared with, by name.</summary>
    internal static async Task<List<DocOrgShareResponse>> SharesAsync(InklayerDbContext db, Guid docId, CancellationToken ct)
    {
        var rows = await (
                from s in db.DocOrgShares.AsNoTracking()
                where s.DocId == docId
                join o in db.Organizations on s.OrganizationId equals o.Id
                select new { s.OrganizationId, o.Name, s.CanEdit, s.SharedAt, s.SharedByUserId })
            .ToListAsync(ct);
        var actors = await DocEndpoints.ActorsAsync(db, rows.Select(r => r.SharedByUserId), ct);
        return [.. rows.OrderBy(r => r.Name, StringComparer.OrdinalIgnoreCase)
            .Select(r => new DocOrgShareResponse(r.OrganizationId, r.Name, r.CanEdit, r.SharedAt, actors[r.SharedByUserId]))];
    }

    /// <summary>The docs other organisations share with <paramref name="orgId"/>, as someone with <paramref name="role"/> there sees them.</summary>
    internal static async Task<List<SharedDocResponse>> SharedWithAsync(InklayerDbContext db, Guid orgId, Role role, CancellationToken ct)
    {
        var rows = await (
                from s in db.DocOrgShares.AsNoTracking()
                where s.OrganizationId == orgId
                join d in db.Docs on s.DocId equals d.Id
                where d.DeletedAt == null
                join o in db.Organizations on d.OrganizationId equals o.Id
                select new { d.Id, d.Title, d.UpdatedAt, d.Icon, d.Color, FromId = o.Id, FromName = o.Name, s.CanEdit })
            .ToListAsync(ct);
        return [.. rows.OrderBy(r => r.Title, StringComparer.OrdinalIgnoreCase)
            .Select(r => new SharedDocResponse(r.Id, r.Title, r.UpdatedAt, new DocOrganizationResponse(r.FromId, r.FromName),
                DocAccess.SharedRole(r.CanEdit, role).Grants(Permission.Comment), r.Icon, r.Color))];
    }
}
