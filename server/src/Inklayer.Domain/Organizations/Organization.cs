using Inklayer.Domain.Authorization;

namespace Inklayer.Domain.Organizations;

public sealed class Organization
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required string Name { get; set; }

    /// <summary>The role given to people who join automatically through an allowed domain.</summary>
    public Role DefaultRole { get; set; } = Role.Viewer;

    public DateTime CreatedAt { get; init; }

    public List<OrganizationDomain> Domains { get; init; } = [];

    public List<OrganizationMember> Members { get; init; } = [];
}

/// <summary>
/// A domain whose users join this organisation automatically on first sign-in: a Google Workspace domain (the <c>hd</c> claim),
/// or a domain an OIDC provider is configured as the authority for (its <c>VerifiedDomains</c>).
/// Each domain belongs to at most one organisation on an instance.
/// </summary>
public sealed class OrganizationDomain
{
    public required Guid OrganizationId { get; init; }

    /// <summary>Lower-case domain, e.g. <c>acme.com</c>.</summary>
    public required string Domain { get; init; }
}

public sealed class OrganizationMember
{
    public required Guid OrganizationId { get; init; }

    public required Guid UserId { get; init; }

    public required Role Role { get; set; }

    public DateTime JoinedAt { get; init; }

    public Users.User? User { get; init; }
}
