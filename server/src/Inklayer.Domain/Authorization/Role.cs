namespace Inklayer.Domain.Authorization;

/// <summary>
/// Roles are ordered: each role can do everything the roles below it can do.
/// <list type="bullet">
/// <item>Viewer, Commenter, Editor and Manager apply to one item (a product, a feature or a doc) through an <see cref="AccessGrant"/>,
/// or to the organisation's General space through the organisation role.</item>
/// <item>Admin and Owner are organisation roles only. They act as Manager on everything in the organisation.</item>
/// </list>
/// </summary>
public enum Role
{
    Viewer = 10,
    Commenter = 20,
    Editor = 30,

    /// <summary>Changes who has access to an item, and its features and audiences.</summary>
    Manager = 35,

    Admin = 40,
    Owner = 50,
}
