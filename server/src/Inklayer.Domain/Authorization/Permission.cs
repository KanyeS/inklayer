namespace Inklayer.Domain.Authorization;

public enum Permission
{
    /// <summary>See an item (an organisation's General space, a product, a feature or a doc) and its content.</summary>
    View,

    /// <summary>Comment on and annotate pages.</summary>
    Comment,

    /// <summary>Change who can access an item; rename and archive products.</summary>
    ManageAccess,

    /// <summary>Create products.</summary>
    ManageProjects,

    /// <summary>Invite, remove and change the roles of members; manage teams; edit organisation settings; read the audit log.</summary>
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
        Permission.ManageAccess => Role.Manager,
        Permission.ManageProjects => Role.Admin,
        Permission.ManageMembers => Role.Admin,
        Permission.ManageOwners => Role.Owner,
        _ => throw new ArgumentOutOfRangeException(nameof(permission), permission, null),
    };

    public static bool Grants(this Role role, Permission permission) => role >= MinimumRole(permission);

    /// <summary>The roles that can be granted on a product, feature or doc.</summary>
    public static bool IsGrantable(Role role) => role is Role.Viewer or Role.Commenter or Role.Editor or Role.Manager;
}
