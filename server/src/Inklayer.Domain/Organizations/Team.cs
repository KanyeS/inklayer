namespace Inklayer.Domain.Organizations;

/// <summary>Where a team's members come from.</summary>
public enum TeamSource
{
    /// <summary>Admins add and remove people in Inklayer.</summary>
    Manual,

    /// <summary>Kept in step with a group claim from single sign-on, at each sign-in.</summary>
    Claim,

    /// <summary>Pushed by the identity provider over SCIM.</summary>
    Scim,
}

/// <summary>
/// A group of people in an organisation, such as "Payments" or "Support". Teams are given access to products, features and
/// docs, and also serve as audiences: who a doc is written for.
/// </summary>
public sealed class Team
{
    public const int MaxNameLength = 100;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    public required string Name { get; set; }

    public TeamSource Source { get; set; } = TeamSource.Manual;

    /// <summary>The identity provider's id for the group (SCIM).</summary>
    public string? ExternalId { get; set; }

    public DateTime CreatedAt { get; init; }

    public List<TeamMember> Members { get; init; } = [];
}

public sealed class TeamMember
{
    public required Guid TeamId { get; init; }

    public required Guid UserId { get; init; }

    public DateTime AddedAt { get; init; }

    public Users.User? User { get; init; }
}
