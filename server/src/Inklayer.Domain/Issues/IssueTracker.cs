namespace Inklayer.Domain.Issues;

public static class TrackerKinds
{
    public const string GitHub = "github";
    public const string Jira = "jira";
    public const string Linear = "linear";
    public const string AzureDevOps = "azuredevops";
    public const string GitLab = "gitlab";

    /// <summary>Forgejo and Gitea, which share an API: Codeberg, and self-hosted instances.</summary>
    public const string Forgejo = "forgejo";

    public static readonly string[] All = [GitHub, Jira, Linear, AzureDevOps, GitLab, Forgejo];

    public static string Name(string kind) => kind switch
    {
        GitHub => "GitHub", Jira => "Jira", Linear => "Linear", AzureDevOps => "Azure DevOps", GitLab => "GitLab", Forgejo => "Forgejo", _ => kind,
    };
}

/// <summary>
/// A project's link to an issue tracker: where issues made from its comments go. A project can have several. Where the
/// tracker supports it (GitHub), people act as themselves through their own <see cref="TrackerAccount"/>, and the shared
/// token is optional: a fallback for people who haven't connected. The token is encrypted; <see cref="Settings"/> holds the rest (repository, Jira site and project, Linear team, Azure DevOps organisation and project) as JSON.
/// </summary>
public sealed class IssueTrackerConnection
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid ProjectId { get; init; }

    public required Guid OrganizationId { get; init; }

    public required string Kind { get; init; }

    public required string Name { get; set; }

    /// <summary>JSON: GitHub <c>{owner, repo, apiUrl?}</c>; Jira <c>{site, projectKey, issueType, email}</c>; Linear <c>{teamId}</c>;
    /// Azure DevOps <c>{site (organisation URL), projectKey (project name), issueType (work item type)}</c>;
    /// GitLab <c>{site?, projectKey (path such as group/project)}</c>; Forgejo and Gitea <c>{site?, owner, repo}</c>.</summary>
    public required string Settings { get; set; }

    /// <summary>The shared account's token (a bot account, say), encrypted. Optional where people can connect their own accounts.</summary>
    public string? ProtectedToken { get; set; }

    /// <summary>Close the issue when its comment is resolved in Inklayer.</summary>
    public bool CloseIssueOnResolve { get; set; } = true;

    /// <summary>Post replies written in Inklayer to linked issues: as their author's own account, or the shared one.</summary>
    public bool PostRepliesToIssue { get; set; }

    public Guid CreatedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public DateTime? LastErrorAt { get; set; }

    public string? LastError { get; set; }
}

/// <summary>
/// Someone's own account in a tracker, connected with OAuth, so what they do from Inklayer (issues, replies,
/// closing) shows as them. One per person and tracker, used in every project. The token is encrypted.
/// </summary>
public sealed class TrackerAccount
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid UserId { get; init; }

    public required string Kind { get; init; }

    /// <summary>The tracker's id for the account, which stays the same when the login is renamed.</summary>
    public required string ExternalUserId { get; set; }

    /// <summary>The account's name in the tracker, such as a GitHub login.</summary>
    public required string Login { get; set; }

    public required string ProtectedAccessToken { get; set; }

    /// <summary>For trackers whose access tokens expire (all but GitHub): gets a new one. Encrypted; some trackers replace it each time.</summary>
    public string? ProtectedRefreshToken { get; set; }

    /// <summary>When the access token stops working; null when it doesn't expire.</summary>
    public DateTime? ExpiresAt { get; set; }

    /// <summary>The account's page in the tracker, where it has one.</summary>
    public string? ProfileUrl { get; set; }

    /// <summary>JSON the tracker needs later: the address it was connected with (for refreshing), and Jira's sites.</summary>
    public string? Data { get; set; }

    public DateTime CreatedAt { get; init; }

    public DateTime UpdatedAt { get; set; }
}

public static class IssueStates
{
    public const string Open = "open";
    public const string Closed = "closed";

    /// <summary>A pull request that was merged (pull requests only).</summary>
    public const string Merged = "merged";
}

/// <summary>An issue made from a comment. Its state is kept in step with the tracker (polled), and with the comment.</summary>
public sealed class AnnotationIssue
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid AnnotationId { get; init; }

    public required Guid ConnectionId { get; init; }

    /// <summary>What the tracker's API calls it: GitHub's number, Jira's key, Linear's id, Azure DevOps' work item id.</summary>
    public required string ExternalId { get; init; }

    /// <summary>What people call it: #12, ABC-34, ENG-5, #1234.</summary>
    public required string Key { get; init; }

    public required string Url { get; init; }

    /// <summary>Its title when it was created or linked, to offer it again without asking the tracker; null for older links.</summary>
    public string? Title { get; init; }

    public string State { get; set; } = IssueStates.Open;

    public required Guid CreatedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public DateTime LastSyncedAt { get; set; }

    /// <summary>An issue that already existed and was linked to the comment, rather than created from it.</summary>
    public bool Linked { get; init; }

    /// <summary>When the tracker said it was closed; null while open. Comments stop being fetched a while after.</summary>
    public DateTime? ClosedAt { get; set; }

    /// <summary>Comments changed since this were fetched last time; null until the first fetch.</summary>
    public DateTime? CommentsCheckedAt { get; set; }

    /// <summary>
    /// A pull request (GitLab: merge request) rather than an issue. Its <see cref="ExternalId"/> is <c>pr:</c> and its number,
    /// so it can't be mistaken for an issue with the same number. Merging it resolves the comment.
    /// </summary>
    public bool PullRequest { get; init; }

    /// <summary>A pull request's: the comment is listed in the summary Inklayer keeps on the pull request.</summary>
    public bool InSummary { get; set; }
}

/// <summary>
/// The comment Inklayer keeps on a pull request, listing the Inklayer comments linked to it. Edited as they change;
/// <see cref="Body"/> is what was last posted, so unchanged summaries aren't sent again.
/// </summary>
public sealed class PullRequestSummary
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid ConnectionId { get; init; }

    /// <summary>The pull request's <see cref="AnnotationIssue.ExternalId"/> (<c>pr:12</c>).</summary>
    public required string PullRequestId { get; init; }

    /// <summary>The tracker's id for the summary comment (Azure DevOps: the repository and thread).</summary>
    public required string CommentExternalId { get; set; }

    /// <summary>Whose own account posted it; null for the connection's shared one. Only they can edit it.</summary>
    public Guid? PostedByUserId { get; set; }

    /// <summary>The Inklayer address its links point to, from when it was first posted.</summary>
    public required string Origin { get; init; }

    public string Body { get; set; } = "";

    public DateTime UpdatedAt { get; set; }
}

/// <summary>
/// A comment on a tracker issue, shown in the thread of every Inklayer comment linked to that issue. Belongs to the issue
/// (connection and external id), so comments linked to the same issue share one copy.
/// </summary>
public sealed class IssueComment
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid ConnectionId { get; init; }

    /// <summary>The issue's id in the tracker (<see cref="AnnotationIssue.ExternalId"/>).</summary>
    public required string IssueExternalId { get; init; }

    /// <summary>The comment's id in the tracker.</summary>
    public required string ExternalId { get; init; }

    public required string AuthorName { get; set; }

    public string? AuthorUrl { get; set; }

    /// <summary>Plain text or markdown, as the tracker gives it (HTML and Jira's document format are turned into text).</summary>
    public required string Body { get; set; }

    public DateTime CreatedAt { get; init; }

    public DateTime UpdatedAt { get; set; }

    /// <summary>Inklayer posted it (a reply or the note when linking), so it isn't shown again as the tracker's.</summary>
    public bool FromInklayer { get; init; }

    /// <summary>The Inklayer reply it was posted from, if any.</summary>
    public Guid? ReplyId { get; init; }
}
