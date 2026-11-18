namespace Inklayer.Domain.Sharing;

public static class ShareKinds
{
    /// <summary>One page's comments in a project.</summary>
    public const string Page = "page";

    /// <summary>Every page's comments in a project.</summary>
    public const string Project = "project";

    /// <summary>One doc, read-only ("make public").</summary>
    public const string Doc = "doc";

    public static readonly IReadOnlySet<string> All = new HashSet<string>(StringComparer.Ordinal) { Page, Project, Doc };
}

/// <summary>
/// A read-only link that works without signing in, and from outside the VPN. The token is looked up by its SHA-256
/// (<see cref="TokenHash"/>); it's also kept encrypted (<see cref="ProtectedToken"/>) so people who can see the share can copy
/// the link again.
/// </summary>
public sealed class ShareLink
{
    public const int MaxPageUrlLength = 2048;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    /// <summary>Lowercase hex SHA-256 of the token.</summary>
    public required string TokenHash { get; init; }

    public required string ProtectedToken { get; init; }

    public required string Kind { get; init; }

    public required Guid OrganizationId { get; init; }

    /// <summary>For page and project shares.</summary>
    public Guid? ProjectId { get; init; }

    /// <summary>For page shares: the page's address as shared; matched like the extension matches pages.</summary>
    public string? PageUrl { get; init; }

    /// <summary>For doc shares.</summary>
    public Guid? DocId { get; init; }

    /// <summary>Whether resolved comments are shown too (page and project shares).</summary>
    public bool IncludeResolved { get; init; }

    public required Guid CreatedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public DateTime? ExpiresAt { get; init; }

    public DateTime? RevokedAt { get; set; }

    public Guid? RevokedByUserId { get; set; }

    public int ViewCount { get; set; }

    public DateTime? LastViewedAt { get; set; }

    public bool IsActive(DateTime now) => RevokedAt is null && (ExpiresAt is null || ExpiresAt > now);
}
