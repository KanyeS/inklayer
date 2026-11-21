using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;
using Inklayer.Domain.Authorization;

namespace Inklayer.Api.Features.Organizations;

public sealed record CreateOrganizationRequest(
    [property: Required, StringLength(200, MinimumLength = 1)] string Name,
    Role? DefaultRole,
    IReadOnlyList<string>? AllowedDomains);

public sealed record UpdateOrganizationRequest(
    [property: StringLength(200, MinimumLength = 1)] string? Name,
    Role? DefaultRole,
    IReadOnlyList<string>? AllowedDomains);

public sealed record OrganizationResponse(Guid Id, string Name, Role DefaultRole, IReadOnlyList<string> AllowedDomains, DateTime CreatedAt, Role MyRole);

/// <param name="DisplayName">The name they chose to be shown as, or their real name.</param>
/// <param name="FullName">Their real name, from their sign-in provider.</param>
public sealed record MemberResponse(Guid UserId, string Email, string DisplayName, string? AvatarUrl, Role Role, DateTime JoinedAt, string? FullName = null);

public sealed record SetRoleRequest([property: Required] Role? Role);

public sealed record CreateInvitationRequest(
    [property: Required, EmailAddress, StringLength(320)] string Email,
    [property: Required] Role? Role);

public sealed record InvitationResponse(Guid Id, string Email, Role Role, DateTime CreatedAt, DateTime ExpiresAt);

public sealed record AuditEventResponse(Guid Id, DateTime OccurredAt, Guid? ActorUserId, string? ActorEmail, string Action, string? TargetType, string? TargetId, string? Data, string? IpAddress);

internal static partial class OrganizationRules
{
    /// <summary>Roles that can be given automatically to anyone from an allowed domain. Admin and Owner must be granted explicitly.</summary>
    public static bool IsValidDefaultRole(Role role) => role is Role.Viewer or Role.Commenter or Role.Editor;

    /// <summary>
    /// An organisation role sets what someone can do in the General space (Viewer, Commenter, Editor), or makes them an Admin or
    /// Owner of everything. Manager only exists on a product, feature or doc.
    /// </summary>
    public static bool IsValidOrganizationRole(Role role) => role != Role.Manager && Enum.IsDefined(role);

    public static string NormalizeDomain(string domain) => domain.Trim().TrimEnd('.').ToLowerInvariant();

    public static bool IsValidDomain(string domain) => domain.Length <= 253 && DomainPattern().IsMatch(domain);

    [GeneratedRegex(@"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")]
    private static partial Regex DomainPattern();
}
