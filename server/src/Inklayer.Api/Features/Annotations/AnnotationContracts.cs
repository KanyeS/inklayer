using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Authorization;

namespace Inklayer.Api.Features.Annotations;

/// <summary>Only the fields that are present change. <see cref="Version"/> must match the annotation's current version.</summary>
public sealed record UpdateAnnotationRequest(
    [property: Range(1, int.MaxValue)] int Version,
    [property: StringLength(10_000)] string? Body,
    [property: StringLength(7)] string? Color,
    AnnotationStatus? Status,
    JsonElement? Anchor,
    JsonElement? Geometry,
    [property: Range(0, 20000)] int? ViewportWidth);

/// <param name="DisplayName">The name they chose to be shown as, or their real name.</param>
/// <param name="FullName">Their real name, from their sign-in provider (shown on hover).</param>
/// <param name="Role">Their role in the organisation the comment belongs to, if they're a member.</param>
public sealed record AuthorSummary(Guid Id, string DisplayName, string? AvatarUrl, string? FullName = null, Role? Role = null);

/// <summary>
/// A new mark on a page. <see cref="Url"/> is the page as the browser sees it; the server keeps only its normalised form
/// (see <c>LivePageUrl</c>): origin and path, plus the query string if <see cref="IncludeQuery"/> and the #hash if
/// <see cref="IncludeHash"/>. The commenter chooses: <c>/watch</c> (every such page) or <c>/watch?v=…</c> (just that one).
/// </summary>
public sealed record CreateLiveAnnotationRequest(
    [property: Required, StringLength(4096)] string? Url,
    [property: Required] AnnotationKind? Kind,
    [property: StringLength(10_000)] string? Body,
    [property: StringLength(7)] string? Color,
    JsonElement Anchor,
    JsonElement Geometry,
    [property: Range(0, 20000)] int ViewportWidth,
    bool IncludeQuery = false,
    bool IncludeHash = false);

/// <param name="DocLinks">The <c>[[doc]]</c> links in the body, with the doc each one opens (null if it doesn't exist yet).</param>
/// <param name="MentionedIn">Docs that link this comment.</param>
public sealed record AnnotationResponse(
    Guid Id, Guid ProjectId, string PageUrl, AnnotationKind Kind, AnnotationStatus Status, string Body, string Color,
    RawJson Anchor, RawJson Geometry, int ViewportWidth, int Version,
    AuthorSummary Author, DateTime CreatedAt, DateTime UpdatedAt, DateTime? ResolvedAt, Guid? ResolvedByUserId,
    bool CanEdit, bool CanDelete, Guid OrganizationId,
    IReadOnlyList<AnnotationDocLink>? DocLinks = null, IReadOnlyList<AnnotationMention>? MentionedIn = null,
    IReadOnlyList<ReplyResponse>? Replies = null,
    AnnotationContextResponse? Context = null, bool HasScreenshot = false,
    IReadOnlyList<Notifications.PersonResponse>? People = null,
    IReadOnlyList<Issues.IssueResponse>? Issues = null,
    IReadOnlyList<Issues.IssueCommentResponse>? IssueComments = null,
    IReadOnlyList<Media.MediaResponse>? Media = null)
{
    /// <summary>The app that left the comment for its author ("Claude Code"), shown as "via …"; empty if they made it themselves.</summary>
    public string Via { get; init; } = "";
}

/// <summary>A reply in a comment's thread, oldest first.</summary>
public sealed record ReplyResponse(Guid Id, string Body, AuthorSummary Author, DateTime CreatedAt, DateTime UpdatedAt, int Version, bool CanEdit, bool CanDelete);

public sealed record CreateReplyRequest([property: Required, StringLength(10_000)] string? Body);

public sealed record UpdateReplyRequest([property: Range(1, int.MaxValue)] int Version, [property: Required, StringLength(10_000)] string? Body);

/// <param name="Text">The link as written (lowercase target is matched; this keeps the original).</param>
public sealed record AnnotationDocLink(string Text, Guid? DocId, string? Title);

public sealed record AnnotationMention(Guid DocId, string Title);

/// <summary>One comment on its own, for links from docs: where it is and which docs mention it.</summary>
public sealed record AnnotationDetailResponse(
    Guid Id, Guid OrganizationId, Guid ProjectId, string ProjectName, string PageUrl, string Body, AnnotationStatus Status, AuthorSummary Author,
    DateTime CreatedAt, IReadOnlyList<AnnotationDocLink> DocLinks, IReadOnlyList<AnnotationMention> MentionedIn,
    IReadOnlyList<ReplyResponse> Replies, bool CanReply,
    AnnotationContextResponse? Context = null, bool HasScreenshot = false,
    IReadOnlyList<Notifications.PersonResponse>? People = null,
    IReadOnlyList<Issues.IssueResponse>? Issues = null,
    IReadOnlyList<Issues.IssueCommentResponse>? IssueComments = null,
    IReadOnlyList<Media.MediaResponse>? Media = null)
{
    /// <summary>The app that left the comment for its author ("Claude Code"), shown as "via …"; empty if they made it themselves.</summary>
    public string Via { get; init; } = "";
}

public sealed record AnnotationRevisionResponse(int Version, string Action, AuthorSummary Actor, DateTime OccurredAt, JsonElement State);
