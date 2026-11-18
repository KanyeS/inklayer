using System.Text.RegularExpressions;

namespace Inklayer.Domain.Notifications;

public static class NotificationKinds
{
    /// <summary>Someone @mentioned you in a comment, reply or doc.</summary>
    public const string Mention = "mention";

    /// <summary>Someone replied to a comment you wrote or replied to.</summary>
    public const string Reply = "reply";

    /// <summary>Someone resolved your comment.</summary>
    public const string Resolved = "resolved";

    /// <summary>An issue linked to your comment was closed.</summary>
    public const string IssueClosed = "issue_closed";
}

/// <summary>Something for one person to look at, shown in their in-app inbox (and emailed, if their organisation sends emails).</summary>
public sealed class Notification
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid UserId { get; init; }

    public required Guid OrganizationId { get; init; }

    public required string Kind { get; init; }

    public Guid? ActorUserId { get; init; }

    public Guid? AnnotationId { get; init; }

    public Guid? DocId { get; init; }

    /// <summary>A short preview of what happened (comment or reply text), with mentions written as names.</summary>
    public string Preview { get; init; } = "";

    /// <summary>Where: the page address, or the doc's title.</summary>
    public string Where { get; init; } = "";

    public DateTime CreatedAt { get; init; }

    public DateTime? ReadAt { get; set; }
}

/// <summary><c>&lt;@user-id&gt;</c> in comments, replies and docs: an @mention of a person, shown as their name.</summary>
public static partial class Mentions
{
    public static IReadOnlyList<Guid> Extract(string? text) =>
        [.. Pattern().Matches(text ?? "").Select(m => Guid.Parse(m.Groups["id"].Value)).Distinct()];

    /// <summary>The text with each mention written as @Name (for previews, emails and AI assistants).</summary>
    public static string ToNames(string text, IReadOnlyDictionary<Guid, string> names) =>
        Pattern().Replace(text, m => names.TryGetValue(Guid.Parse(m.Groups["id"].Value), out var name) ? "@" + name : "@someone");

    [GeneratedRegex(@"<@(?<id>[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>")]
    private static partial Regex Pattern();
}
