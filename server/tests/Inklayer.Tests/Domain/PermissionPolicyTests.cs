using Inklayer.Domain.Authorization;

namespace Inklayer.Tests.Domain;

public sealed class PermissionPolicyTests
{
    [Theory]
    [InlineData(Role.Viewer, Permission.View, true)]
    [InlineData(Role.Viewer, Permission.Comment, false)]
    [InlineData(Role.Commenter, Permission.Comment, true)]
    [InlineData(Role.Editor, Permission.ManageAccess, false)]
    [InlineData(Role.Manager, Permission.ManageAccess, true)]
    [InlineData(Role.Manager, Permission.ManageProjects, false)]
    [InlineData(Role.Admin, Permission.ManageAccess, true)]
    [InlineData(Role.Admin, Permission.ManageMembers, true)]
    [InlineData(Role.Admin, Permission.ManageOwners, false)]
    [InlineData(Role.Owner, Permission.ManageOwners, true)]
    public void Roles_grant_permissions_cumulatively(Role role, Permission permission, bool expected)
    {
        Assert.Equal(expected, role.Grants(permission));
    }
}

public sealed class AccessPolicyTests
{
    private static AccessLevel Level(bool restricted = false, params Role[] roles) => new(roles, restricted);

    [Fact]
    public void No_grant_means_no_access()
    {
        Assert.Null(AccessPolicy.Resolve(Role.Editor, [Level()]));
    }

    [Fact]
    public void Non_members_have_no_access_whatever_is_granted()
    {
        Assert.Null(AccessPolicy.Resolve(null, [Level(false, Role.Manager)]));
    }

    [Theory]
    [InlineData(Role.Admin)]
    [InlineData(Role.Owner)]
    public void Organisation_admins_and_owners_keep_their_role_everywhere(Role orgRole)
    {
        Assert.Equal(orgRole, AccessPolicy.Resolve(orgRole, [Level(true)]));
    }

    [Fact]
    public void The_highest_grant_wins()
    {
        Assert.Equal(Role.Editor, AccessPolicy.Resolve(Role.Viewer, [Level(false, Role.Viewer, Role.Editor, Role.Commenter)]));
    }

    [Fact]
    public void Grants_flow_down_and_can_be_raised_below()
    {
        Assert.Equal(Role.Viewer, AccessPolicy.Resolve(Role.Viewer, [Level(false, Role.Viewer), Level()]));
        Assert.Equal(Role.Manager, AccessPolicy.Resolve(Role.Viewer, [Level(false, Role.Viewer), Level(false, Role.Manager)]));
    }

    [Fact]
    public void Grants_below_never_lower_what_is_inherited()
    {
        Assert.Equal(Role.Editor, AccessPolicy.Resolve(Role.Viewer, [Level(false, Role.Editor), Level(false, Role.Viewer)]));
    }

    [Fact]
    public void A_restricted_item_ignores_grants_above_it()
    {
        Assert.Null(AccessPolicy.Resolve(Role.Viewer, [Level(false, Role.Manager), Level(true)]));
        Assert.Equal(Role.Viewer, AccessPolicy.Resolve(Role.Viewer, [Level(false, Role.Manager), Level(true, Role.Viewer)]));
    }

    [Fact]
    public void Audiences_narrow_what_viewers_and_commenters_see()
    {
        var support = Guid.NewGuid();
        var engineering = Guid.NewGuid();
        IReadOnlySet<Guid> inSupport = new HashSet<Guid> { support };

        Assert.True(AccessPolicy.CanSee(Role.Viewer, [], inSupport));
        Assert.True(AccessPolicy.CanSee(Role.Viewer, [support], inSupport));
        Assert.False(AccessPolicy.CanSee(Role.Commenter, [engineering], inSupport));
        Assert.True(AccessPolicy.CanSee(Role.Editor, [engineering], inSupport));
        Assert.False(AccessPolicy.CanSee(null, [], inSupport));
    }
}
