namespace Inklayer.Domain.Authorization;

/// <summary>
/// One level of the path to an item, from the top down: the product, then its feature, then the doc.
/// </summary>
/// <param name="Roles">The roles granted on this level to the caller or any of their teams.</param>
/// <param name="IsRestricted">When true, grants on the levels above don't apply here or below.</param>
public readonly record struct AccessLevel(IReadOnlyCollection<Role> Roles, bool IsRestricted = false);

/// <summary>
/// The one access rule.
/// <list type="number">
/// <item>Organisation Admins and Owners keep their role on everything in the organisation.</item>
/// <item>Otherwise your role is the highest role granted to you or any of your teams on the item or the items above it.
/// A restricted item ignores what's granted above it.</item>
/// <item>No grant means no access: the item doesn't exist for you.</item>
/// </list>
/// Audiences (<see cref="CanSee"/>) then narrow what Viewers and Commenters are shown.
/// </summary>
public static class AccessPolicy
{
    /// <summary>The caller's role on the item at the end of <paramref name="path"/>, or null for no access.</summary>
    public static Role? Resolve(Role? organizationRole, IEnumerable<AccessLevel> path)
    {
        ArgumentNullException.ThrowIfNull(path);
        if (organizationRole >= Role.Admin)
        {
            return organizationRole;
        }

        if (organizationRole is null)
        {
            return null;
        }

        Role? role = null;
        foreach (var level in path)
        {
            if (level.IsRestricted)
            {
                role = null;
            }

            foreach (var granted in level.Roles)
            {
                if (role is null || granted > role)
                {
                    role = granted;
                }
            }
        }

        return role;
    }

    /// <summary>
    /// Whether someone with <paramref name="role"/> sees an item aimed at <paramref name="audienceTeamIds"/>. An empty audience
    /// means everyone with access. Editors and above always see it, so they can maintain it.
    /// </summary>
    public static bool CanSee(Role? role, IReadOnlyCollection<Guid> audienceTeamIds, IReadOnlySet<Guid> callerTeamIds)
    {
        ArgumentNullException.ThrowIfNull(audienceTeamIds);
        ArgumentNullException.ThrowIfNull(callerTeamIds);
        return role is { } r && r.Grants(Permission.View)
            && (audienceTeamIds.Count == 0 || r >= Role.Editor || audienceTeamIds.Any(callerTeamIds.Contains));
    }
}
