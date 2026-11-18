namespace Inklayer.Tests.Infrastructure;

// Client-side shapes of API responses. Kept separate from the server's types so the tests check the wire format.
public sealed record MeDto(Guid Id, string Email, string DisplayName, bool IsSystemAdmin, List<MyOrgDto> Organizations);

public sealed record MyOrgDto(Guid Id, string Name, string Role);

public sealed record OrgDto(Guid Id, string Name, string DefaultRole, List<string> AllowedDomains, string MyRole);

public sealed record MemberDto(Guid UserId, string Email, string Role);

public sealed record InvitationDto(Guid Id, string Email, string Role);

public sealed record ProjectDto(Guid Id, Guid OrganizationId, string Name, bool IsArchived, string MyRole);

public sealed record ProjectMemberDto(Guid UserId, string Email, string OrganizationRole, string? ProjectRole, string EffectiveRole);

public sealed record AuditDto(Guid Id, string Action, Guid? ActorUserId, string? TargetId, string? Data);

public sealed record TokenDto(
    [property: System.Text.Json.Serialization.JsonPropertyName("access_token")] string AccessToken,
    [property: System.Text.Json.Serialization.JsonPropertyName("refresh_token")] string? RefreshToken,
    [property: System.Text.Json.Serialization.JsonPropertyName("token_type")] string TokenType);

public sealed record MissingDto(List<string> Missing);

public sealed record UserSummaryDto(Guid Id, string DisplayName);

public sealed record SnapshotDto(
    Guid Id, Guid ProjectId, string Url, string Title, UserSummaryDto CapturedBy, int ViewportWidth, int AssetCount, long TotalBytes,
    Uri? ViewUrl, string? ScreenshotUrl);

public sealed record SnapshotSummaryDto(Guid Id, string Url, string Title, bool HasScreenshot, int AssetCount);
