namespace Inklayer.Domain.Authorization;

public enum Permission
{
    /// <summary>See the organisation, its projects, members and content.</summary>
    View,

    /// <summary>Comment on and annotate pages.</summary>
    Comment,

    /// <summary>Create, rename and archive projects; set per-project roles.</summary>
    ManageProjects,

    /// <summary>Invite, remove and change the roles of members; edit organisation settings; read the audit log.</summary>
    ManageMembers,

    /// <summary>Grant or revoke the Owner role.</summary>
    ManageOwners,
}

public static class PermissionPolicy
{
    /// <summary>The lowest role that grants each permission.</summary>
    public static Role MinimumRole(Permission permission) => permission switch
    {
        Permission.View => Role.Viewer,
        Permission.Comment => Role.Commenter,
        Permission.ManageProjects => Role.Admin,
        Permission.ManageMembers => Role.Admin,
        Permission.ManageOwners => Role.Owner,
        _ => throw new ArgumentOutOfRangeException(nameof(permission), permission, null),
    };

    public static bool Grants(this Role role, Permission permission) => role >= MinimumRole(permission);

    /// <summary>
    /// The role that applies inside a project. Organisation Admins and Owners keep their role in every project.
    /// Other members get the project override if one is set, which can raise or lower their access; otherwise their organisation role applies.
    /// </summary>
    public static Role EffectiveProjectRole(Role organizationRole, Role? projectOverride) =>
        organizationRole >= Role.Admin ? organizationRole : projectOverride ?? organizationRole;
}
