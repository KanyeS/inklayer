using Inklayer.Domain.Authorization;

namespace Inklayer.Domain.Organizations;

/// <summary>
/// Lets one email address into an organisation. When someone signs in with Google and the verified email matches,
/// the invitation is accepted and they become a member with <see cref="Role"/>.
/// </summary>
public sealed class Invitation
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    /// <summary>Lower-cased email address.</summary>
    public required string Email { get; init; }

    public required Role Role { get; set; }

    public required Guid InvitedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public DateTime ExpiresAt { get; set; }

    public DateTime? AcceptedAt { get; set; }

    public bool IsPending(DateTime now) => AcceptedAt is null && ExpiresAt > now;
}
