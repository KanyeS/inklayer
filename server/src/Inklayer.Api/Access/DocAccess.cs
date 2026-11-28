using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Access;

/// <summary>
/// Someone's access to one doc.
/// </summary>
/// <param name="HomeRole">Their role in the doc's own organisation, or null if they aren't a member of it.</param>
/// <param name="SharedRole">Their role through organisations the doc is shared with (see <see cref="Domain.Docs.DocOrgShare"/>), or null.</param>
/// <param name="OrganizationId">The doc's own organisation.</param>
public sealed record DocRole(Role? HomeRole, Role? SharedRole, Guid OrganizationId)
{
    /// <summary>What they can do with the doc's text: the higher of the two.</summary>
    public Role Role => (HomeRole, SharedRole) switch
    {
        ({ } home, { } shared) => home > shared ? home : shared,
        ({ } home, null) => home,
        (null, { } shared) => shared,
        _ => throw new InvalidOperationException("No access."),
    };

    /// <summary>Whether they reach it through its own organisation, which is what renaming, moving, deleting and sharing it needs.</summary>
    public bool IsHome => HomeRole is not null;
}

/// <summary>
/// The rule for who can open a doc: members of its own organisation, with their role there; and members of each organisation
/// it's shared with, as Viewer, or as Commenter (edits the text) when the share allows editing and they're Commenter or
/// above in that organisation. Instance administrators are Owners of every organisation.
/// </summary>
internal static class DocAccess
{
    /// <summary>The user's access to a doc, or null if they can't open it (or it doesn't exist).</summary>
    /// <param name="includeDeleted">Also for a deleted doc (history, and docs open when they were deleted).</param>
    public static async Task<DocRole?> RoleAsync(InklayerDbContext db, Guid userId, Guid docId, bool includeDeleted, CancellationToken ct)
    {
        var user = await db.Users.AsNoTracking().Where(u => u.Id == userId).Select(u => new { u.IsDisabled, u.IsSystemAdmin }).SingleOrDefaultAsync(ct);
        if (user is null || user.IsDisabled)
        {
            return null;
        }

        var orgId = await db.Docs.AsNoTracking().Where(d => d.Id == docId && (includeDeleted || d.DeletedAt == null))
            .Select(d => (Guid?)d.OrganizationId).SingleOrDefaultAsync(ct);
        if (orgId is null)
        {
            return null;
        }

        if (user.IsSystemAdmin)
        {
            return new DocRole(Role.Owner, null, orgId.Value);
        }

        var home = await db.OrganizationMembers.Where(m => m.OrganizationId == orgId && m.UserId == userId).Select(m => (Role?)m.Role).SingleOrDefaultAsync(ct);
        var shared = await (
                from s in db.DocOrgShares
                where s.DocId == docId
                join m in db.OrganizationMembers on s.OrganizationId equals m.OrganizationId
                where m.UserId == userId
                select new { s.CanEdit, m.Role })
            .ToListAsync(ct);
        Role? sharedRole = shared.Count == 0 ? null : shared.Max(s => SharedRole(s.CanEdit, s.Role));
        return home is null && sharedRole is null ? null : new DocRole(home, sharedRole, orgId.Value);
    }

    /// <summary>A member's role on a doc shared with their organisation.</summary>
    public static Role SharedRole(bool canEdit, Role organizationRole) =>
        canEdit && organizationRole.Grants(Permission.Comment) ? Role.Commenter : Role.Viewer;

    /// <summary>The docs, among <paramref name="docIds"/>, that the user can open: in their organisations, or shared with them.</summary>
    public static async Task<HashSet<Guid>> VisibleAsync(InklayerDbContext db, Guid userId, IReadOnlyCollection<Guid> docIds, CancellationToken ct)
    {
        if (docIds.Count == 0)
        {
            return [];
        }

        if (await db.Users.AnyAsync(u => u.Id == userId && u.IsSystemAdmin && !u.IsDisabled, ct))
        {
            return [.. docIds];
        }

        var orgIds = db.OrganizationMembers.Where(m => m.UserId == userId).Select(m => m.OrganizationId);
        return (await db.Docs.AsNoTracking()
            .Where(d => docIds.Contains(d.Id) && (orgIds.Contains(d.OrganizationId) || db.DocOrgShares.Any(s => s.DocId == d.Id && orgIds.Contains(s.OrganizationId))))
            .Select(d => d.Id).ToListAsync(ct)).ToHashSet();
    }
}
