namespace Inklayer.Domain.Auditing;

/// <summary>An append-only record of a security-relevant action. Audit events are never updated or deleted by the application.</summary>
public sealed class AuditEvent
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public DateTime OccurredAt { get; init; }

    /// <summary>Null for anonymous events, such as a refused sign-in.</summary>
    public Guid? ActorUserId { get; init; }

    public Guid? OrganizationId { get; init; }

    /// <summary>Dotted action name, e.g. <c>member.role_changed</c>. See <see cref="AuditActions"/>.</summary>
    public required string Action { get; init; }

    public string? TargetType { get; init; }

    public string? TargetId { get; init; }

    /// <summary>Small JSON object with event details.</summary>
    public string? Data { get; init; }

    public string? IpAddress { get; init; }
}

public static class AuditActions
{
    public const string SignInSucceeded = "auth.sign_in";
    public const string SignInDenied = "auth.sign_in_denied";
    public const string LoginLinked = "auth.login_linked";
    public const string SessionsRevoked = "auth.sessions_revoked";
    public const string OrganizationCreated = "org.created";
    public const string OrganizationUpdated = "org.updated";
    public const string MemberJoined = "member.joined";
    public const string MemberRoleChanged = "member.role_changed";
    public const string MemberRemoved = "member.removed";
    public const string InvitationCreated = "invitation.created";
    public const string InvitationRevoked = "invitation.revoked";
    public const string InvitationAccepted = "invitation.accepted";
    public const string ProjectCreated = "project.created";
    public const string ProjectUpdated = "project.updated";
    public const string TeamCreated = "team.created";
    public const string TeamUpdated = "team.updated";
    public const string TeamDeleted = "team.deleted";
    public const string TeamMemberAdded = "team.member_added";
    public const string TeamMemberRemoved = "team.member_removed";
    public const string AccessGranted = "access.granted";
    public const string AccessRevoked = "access.revoked";
    public const string AccessRequested = "access.requested";
    public const string AccessRequestApproved = "access.request_approved";
    public const string AccessRequestDeclined = "access.request_declined";
    public const string DocSharedWithOrganization = "doc.shared_with_org";
    public const string DocUnsharedWithOrganization = "doc.unshared_with_org";
    public const string UserDisabled = "user.disabled";
    public const string UserEnabled = "user.enabled";
    public const string NetworkAccessChanged = "network.changed";
    public const string FeaturesChanged = "features.changed";
    public const string SignInProviderAdded = "sign_in_provider.added";
    public const string SignInProviderChanged = "sign_in_provider.changed";
    public const string SignInProviderRemoved = "sign_in_provider.removed";
    public const string TrackerAppSaved = "tracker_app.saved";
    public const string TrackerAppRemoved = "tracker_app.removed";
}
