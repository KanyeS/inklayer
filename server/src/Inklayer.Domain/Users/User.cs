namespace Inklayer.Domain.Users;

/// <summary>
/// A person who signs in through a single sign-on provider (Google, or an OpenID Connect provider such as JumpCloud or Okta).
/// Inklayer stores no password or credential; <see cref="Logins"/> link the record to provider accounts.
/// </summary>
public sealed class User
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    /// <summary>Lower-cased, verified email address.</summary>
    public required string Email { get; set; }

    /// <summary>The name from the sign-in provider (the person's real name). Updated on every sign-in.</summary>
    public required string DisplayName { get; set; }

    public const int MaxPreferredNameLength = 80;

    /// <summary>The name the person chose to be shown as, if any. Sign-in never changes it.</summary>
    public string? PreferredName { get; set; }

    /// <summary>The name shown to others: the chosen one, or the real one. (In queries, use <c>PreferredName ?? DisplayName</c>.)</summary>
    public string Name => PreferredName ?? DisplayName;

    public string? AvatarUrl { get; set; }

    /// <summary>Instance administrator: can create organisations, manage users and access every organisation.</summary>
    public bool IsSystemAdmin { get; set; }

    public bool IsDisabled { get; set; }

    /// <summary>Changes whenever existing sessions and tokens must stop working (disable, "sign out everywhere").</summary>
    public string SecurityStamp { get; private set; } = NewStamp();

    public DateTime CreatedAt { get; init; }

    public DateTime LastSignInAt { get; set; }

    public List<UserLogin> Logins { get; init; } = [];

    public void RotateSecurityStamp() => SecurityStamp = NewStamp();

    private static string NewStamp() => Guid.NewGuid().ToString("N");
}

/// <summary>An account at a sign-on provider that signs in as a <see cref="User"/>. A user can have one per provider.</summary>
public sealed class UserLogin
{
    public required Guid UserId { get; init; }

    /// <summary>The configured provider id, e.g. <c>google</c> or <c>jumpcloud</c>.</summary>
    public required string Provider { get; init; }

    /// <summary>The provider's stable, unique account identifier (the <c>sub</c> claim).</summary>
    public required string Subject { get; init; }

    public DateTime CreatedAt { get; init; }
}
