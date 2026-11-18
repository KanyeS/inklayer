namespace Inklayer.Domain.Users;

/// <summary>
/// A person who signed in with Google. Inklayer stores no password or credential; only the Google subject
/// identifier links the record to a Google account.
/// </summary>
public sealed class User
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    /// <summary>Google's stable, unique account identifier (the <c>sub</c> claim).</summary>
    public required string GoogleSubject { get; init; }

    /// <summary>Lower-cased, verified email address.</summary>
    public required string Email { get; set; }

    public required string DisplayName { get; set; }

    public string? AvatarUrl { get; set; }

    /// <summary>Instance administrator: can create organisations, manage users and access every organisation.</summary>
    public bool IsSystemAdmin { get; set; }

    public bool IsDisabled { get; set; }

    /// <summary>Changes whenever existing sessions and tokens must stop working (disable, "sign out everywhere").</summary>
    public string SecurityStamp { get; private set; } = NewStamp();

    public DateTime CreatedAt { get; init; }

    public DateTime LastSignInAt { get; set; }

    public void RotateSecurityStamp() => SecurityStamp = NewStamp();

    private static string NewStamp() => Guid.NewGuid().ToString("N");
}
