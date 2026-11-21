namespace Inklayer.Domain.Authorization;

/// <summary>The kinds of item access can be granted on. Items nest: a product holds features, and features hold docs.</summary>
public enum AccessResourceType
{
    /// <summary>A product (<c>Project</c> in code).</summary>
    Project,
    Feature,
    Doc,
}

public enum AccessPrincipalType
{
    User,
    Team,
}

/// <summary>
/// Gives a person or a team a role on one item. Grants flow down: a grant on a product applies to its features and docs,
/// unless one of those is restricted (see <see cref="AccessPolicy"/>).
/// </summary>
public sealed class AccessGrant
{
    public required Guid OrganizationId { get; init; }

    public required AccessResourceType ResourceType { get; init; }

    public required Guid ResourceId { get; init; }

    public required AccessPrincipalType PrincipalType { get; init; }

    public required Guid PrincipalId { get; init; }

    /// <summary>Viewer, Commenter, Editor or Manager.</summary>
    public required Role Role { get; set; }

    public DateTime CreatedAt { get; init; }

    public Guid? CreatedByUserId { get; init; }
}
