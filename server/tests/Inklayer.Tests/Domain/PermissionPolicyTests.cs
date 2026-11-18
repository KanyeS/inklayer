using Inklayer.Domain.Authorization;

namespace Inklayer.Tests.Domain;

public sealed class PermissionPolicyTests
{
    [Theory]
    [InlineData(Role.Viewer, Permission.View, true)]
    [InlineData(Role.Viewer, Permission.Comment, false)]
    [InlineData(Role.Commenter, Permission.Comment, true)]
    [InlineData(Role.Editor, Permission.ManageProjects, false)]
    [InlineData(Role.Admin, Permission.ManageMembers, true)]
    [InlineData(Role.Admin, Permission.ManageOwners, false)]
    [InlineData(Role.Owner, Permission.ManageOwners, true)]
    public void Roles_grant_permissions_cumulatively(Role role, Permission permission, bool expected)
    {
        Assert.Equal(expected, role.Grants(permission));
    }

    [Theory]
    [InlineData(Role.Viewer, null, Role.Viewer)]
    [InlineData(Role.Viewer, Role.Editor, Role.Editor)]
    [InlineData(Role.Editor, Role.Viewer, Role.Viewer)]
    [InlineData(Role.Admin, Role.Viewer, Role.Admin)]
    [InlineData(Role.Owner, Role.Commenter, Role.Owner)]
    public void Project_overrides_apply_below_admin(Role orgRole, Role? projectOverride, Role expected)
    {
        Assert.Equal(expected, PermissionPolicy.EffectiveProjectRole(orgRole, projectOverride));
    }
}
