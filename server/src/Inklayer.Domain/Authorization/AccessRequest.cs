namespace Inklayer.Domain.Authorization;

public enum AccessRequestStatus
{
    Pending,
    Approved,
    Declined,
}

/// <summary>
/// Someone asking for access to an item they can see exists but can't open (a product, for now). The item's Managers and the
/// organisation's Admins hear about it; approving it gives the person a grant. One request per person and item is pending at a time.
/// </summary>
public sealed class AccessRequest
{
    public const int MaxMessageLength = 1000;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    public required AccessResourceType ResourceType { get; init; }

    public required Guid ResourceId { get; init; }

    public required Guid UserId { get; init; }

    /// <summary>The role asked for; whoever approves can give a different one.</summary>
    public required Role Role { get; set; }

    public string Message { get; set; } = "";

    public AccessRequestStatus Status { get; set; } = AccessRequestStatus.Pending;

    public DateTime CreatedAt { get; init; }

    public DateTime? DecidedAt { get; set; }

    public Guid? DecidedByUserId { get; set; }

    public Users.User? User { get; init; }
}
