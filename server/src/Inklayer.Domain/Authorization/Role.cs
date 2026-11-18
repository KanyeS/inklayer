namespace Inklayer.Domain.Authorization;

/// <summary>Roles are ordered: each role can do everything the roles below it can do.</summary>
public enum Role
{
    Viewer = 10,
    Commenter = 20,
    Editor = 30,
    Admin = 40,
    Owner = 50,
}
