namespace Inklayer.Domain.Issues;

public static class TrackerKinds
{
    public const string GitHub = "github";
    public const string Jira = "jira";
    public const string Linear = "linear";

    public static readonly string[] All = [GitHub, Jira, Linear];

    public static string Name(string kind) => kind switch { GitHub => "GitHub", Jira => "Jira", Linear => "Linear", _ => kind };
}

/// <summary>
/// A project's link to an issue tracker: where issues made from its comments go. A project can have several. The token is
/// encrypted; <see cref="Settings"/> holds the rest (repository, Jira site and project, Linear team) as JSON.
/// </summary>
public sealed class IssueTrackerConnection
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid ProjectId { get; init; }

    public required Guid OrganizationId { get; init; }

    public required string Kind { get; init; }

    public required string Name { get; set; }

    /// <summary>JSON: GitHub <c>{owner, repo, apiUrl?}</c>; Jira <c>{site, projectKey, issueType, email}</c>; Linear <c>{teamId}</c>.</summary>
    public required string Settings { get; set; }

    public required string ProtectedToken { get; set; }

    /// <summary>Close the issue when its comment is resolved in Inklayer.</summary>
    public bool CloseIssueOnResolve { get; set; } = true;

    public Guid CreatedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public DateTime? LastErrorAt { get; set; }

    public string? LastError { get; set; }
}

public static class IssueStates
{
    public const string Open = "open";
    public const string Closed = "closed";
}

/// <summary>An issue made from a comment. Its state is kept in step with the tracker (polled), and with the comment.</summary>
public sealed class AnnotationIssue
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid AnnotationId { get; init; }

    public required Guid ConnectionId { get; init; }

    /// <summary>What the tracker's API calls it: GitHub's number, Jira's key, Linear's id.</summary>
    public required string ExternalId { get; init; }

    /// <summary>What people call it: #12, ABC-34, ENG-5.</summary>
    public required string Key { get; init; }

    public required string Url { get; init; }

    public string State { get; set; } = IssueStates.Open;

    public required Guid CreatedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public DateTime LastSyncedAt { get; set; }
}
