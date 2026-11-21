using System.Net;
using System.Text;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <summary>
/// Pull requests (GitLab: merge requests) linked to comments. They're kept apart from issues by their id
/// (<c>pr:12</c>). Merging one resolves its comments; Inklayer keeps a summary comment on it listing them.
/// </summary>
internal sealed partial class IssueService
{
    private const string PullRequestPrefix = "pr:";

    public static bool IsPullRequest(string externalId) => externalId.StartsWith(PullRequestPrefix, StringComparison.Ordinal);

    /// <summary>The tracker's own number for a pull request's id (<c>pr:12</c> is 12).</summary>
    public static string PullRequestNumber(string externalId) => externalId[PullRequestPrefix.Length..];

    private static FoundIssue AsPullRequest(FoundIssue found) => found with { ExternalId = PullRequestPrefix + found.ExternalId };

    /// <summary>Trackers whose pull requests can be linked: GitHub, GitLab, Forgejo, Azure DevOps.</summary>
    public static bool KindHasPullRequests(string kind) =>
        kind is TrackerKinds.GitHub or TrackerKinds.GitLab or TrackerKinds.Forgejo or TrackerKinds.AzureDevOps;

    private IPullRequests PullRequestsOf(IssueTrackerConnection connection) =>
        trackers.For(connection.Kind) as IPullRequests ?? throw new InvalidOperationException($"{TrackerKinds.Name(connection.Kind)} has no pull requests to link.");

    private async Task<AnnotationIssue> LinkPullRequestAsync(
        Annotation comment, IssueTrackerConnection connection, FoundIssue found, bool inSummary, Guid actorUserId, CancellationToken ct)
    {
        var now = clock.GetUtcNow().UtcDateTime;
        var link = new AnnotationIssue
        {
            AnnotationId = comment.Id, ConnectionId = connection.Id, ExternalId = found.ExternalId, Key = found.Key, Url = found.Url, State = found.State,
            Title = Clip(found.Title),
            ClosedAt = found.State == IssueStates.Open ? null : now, Linked = true, PullRequest = true, InSummary = inSummary,
            CreatedByUserId = actorUserId, CreatedAt = now, LastSyncedAt = now, CommentsCheckedAt = now,
        };
        db.AnnotationIssues.Add(link);
        await db.SaveChangesAsync(ct);
        if (inSummary)
        {
            await UpdateSummaryAsync(connection, found.ExternalId, actorUserId, ct);
        }

        await notifications.IssueCreatedAsync(comment, actorUserId, $"{TrackerKinds.Name(connection.Kind)} {link.Key}", link.Url, ct, linked: true);
        return link;
    }

    /// <summary>The comment changed (resolved, reopened): bring the summaries of the pull requests it's in up to date.</summary>
    public async Task UpdateSummariesForAsync(Guid annotationId, Guid? actorUserId, CancellationToken ct)
    {
        var pulls = await db.AnnotationIssues.AsNoTracking()
            .Where(i => i.AnnotationId == annotationId && i.PullRequest && i.InSummary)
            .Select(i => new { i.ConnectionId, i.ExternalId }).Distinct().ToListAsync(ct);
        foreach (var pull in pulls)
        {
            if (await db.IssueTrackerConnections.SingleOrDefaultAsync(c => c.Id == pull.ConnectionId, ct) is { } connection)
            {
                await UpdateSummaryAsync(connection, pull.ExternalId, actorUserId, ct);
            }
        }
    }

    /// <summary>
    /// Posts, or edits, the comment on the pull request listing the Inklayer comments linked to it. Edited as whoever
    /// posted it (only they can); posted afresh when that's no longer possible. Failures are noted on the connection.
    /// </summary>
    public async Task UpdateSummaryAsync(IssueTrackerConnection connection, string pullRequestId, Guid? actorUserId, CancellationToken ct)
    {
        if (trackers.For(connection.Kind) is not IPullRequests pulls)
        {
            return;
        }

        var rows = await (from i in db.AnnotationIssues.AsNoTracking()
                          where i.ConnectionId == connection.Id && i.ExternalId == pullRequestId && i.InSummary
                          join a in db.Annotations.AsNoTracking() on i.AnnotationId equals a.Id
                          where a.DeletedAt == null
                          orderby i.CreatedAt
                          select new { Link = i, Comment = a }).ToListAsync(ct);
        var summary = await db.PullRequestSummaries.SingleOrDefaultAsync(x => x.ConnectionId == connection.Id && x.PullRequestId == pullRequestId, ct);
        if (rows.Count == 0 && summary is null)
        {
            return;
        }

        var origin = summary?.Origin ?? Origin();
        var body = await SummaryBodyAsync([.. rows.Select(r => r.Comment)], origin, ct);
        if (summary?.Body == body)
        {
            return;
        }

        var settings = SettingsOf(connection);
        var number = PullRequestNumber(pullRequestId);
        var key = rows.Count > 0 ? rows[0].Link.Key : number;
        var now = clock.GetUtcNow().UtcDateTime;

        // The account that posted it, so it can be edited; else whoever is acting, else anyone involved.
        TrackerToken? token = null;
        if (summary is not null)
        {
            token = summary.PostedByUserId is { } poster
                ? await accounts.AccountAsync(poster, connection.Kind, ct) is { } account && accounts.PersonalFor(connection) ? await accounts.TokenAsync(account, settings, ct) : null
                : accounts.Shared(connection);
        }

        var editing = token is not null;
        token ??= (actorUserId is { } actor ? await accounts.ForUserAsync(connection, actor, ct) : null)
            ?? await accounts.ForBackgroundAsync(connection, rows.Select(r => r.Link.CreatedByUserId), ct);
        if (token is null)
        {
            connection.LastError = Clip($"Couldn't update the summary on {key}: no one involved has a {TrackerKinds.Name(connection.Kind)} account connected, and there's no shared one.");
            connection.LastErrorAt = now;
            await db.SaveChangesAsync(ct);
            return;
        }

        try
        {
            if (editing && summary is not null)
            {
                try
                {
                    await accounts.WithAsync(token, async t =>
                    {
                        await pulls.EditPullRequestCommentAsync(settings, t, number, summary.CommentExternalId, body, ct);
                        return true;
                    }, ct);
                    summary.Body = body;
                    summary.UpdatedAt = now;
                    await db.SaveChangesAsync(ct);
                    return;
                }
                catch (HttpRequestException ex) when (ex.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden)
                {
                    // Deleted in the tracker, or can't be edited any more: post a new one.
                }
            }

            var id = await accounts.WithAsync(token, t => pulls.AddPullRequestCommentAsync(settings, t, number, body, ct), ct);
            if (summary is null)
            {
                summary = new PullRequestSummary { ConnectionId = connection.Id, PullRequestId = pullRequestId, CommentExternalId = id, Origin = origin };
                db.PullRequestSummaries.Add(summary);
            }

            summary.CommentExternalId = id;
            summary.PostedByUserId = token.Account?.UserId;
            summary.Body = body;
            summary.UpdatedAt = now;
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            connection.LastError = Clip($"Updating the summary on {key}: {ex.Message}");
            connection.LastErrorAt = now;
            await db.SaveChangesAsync(ct);
        }
    }

    /// <summary>The summary: each comment's state, first line, author, page, issues, and a link back to Inklayer.</summary>
    private async Task<string> SummaryBodyAsync(List<Annotation> comments, string origin, CancellationToken ct)
    {
        var body = new StringBuilder("**Inklayer comments linked to this pull request**\n\n");
        if (comments.Count == 0)
        {
            body.Append("None any more.\n");
            return body.ToString();
        }

        var ids = comments.Select(c => c.Id).ToList();
        var authorIds = comments.Select(c => c.AuthorUserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => authorIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var issues = await (from i in db.AnnotationIssues.AsNoTracking()
                            where ids.Contains(i.AnnotationId) && !i.PullRequest
                            join c in db.IssueTrackerConnections on i.ConnectionId equals c.Id
                            orderby i.CreatedAt
                            select new { i.AnnotationId, c.Kind, i.Key, i.Url, i.State }).ToListAsync(ct);
        foreach (var comment in comments)
        {
            var firstLine = Plain(comment.Body.Split('\n')[0].Trim());
            var text = firstLine.Length == 0 ? "(no text)" : Clip(firstLine, 120);
            var state = comment.Status == AnnotationStatus.Resolved ? "✅ Resolved" : "🔵 Open";
            body.Append($"- {state}: **{text}** by {Plain(names.GetValueOrDefault(comment.AuthorUserId, "someone"))} on [{Plain(Shorten(comment.PageUrl))}]({comment.PageUrl})");
            if (origin.Length > 0)
            {
                body.Append($" · [Open in Inklayer]({origin}/comments/{comment.Id})");
            }

            foreach (var issue in issues.Where(i => i.AnnotationId == comment.Id))
            {
                body.Append($" · [{TrackerKinds.Name(issue.Kind)} {Plain(issue.Key)}]({issue.Url}){(issue.State == IssueStates.Open ? "" : " (closed)")}");
            }

            body.Append('\n');
        }

        body.Append("\n<sub>Kept up to date by Inklayer.</sub>\n");
        return body.ToString();
    }

    /// <summary>Text that can't turn into markdown links, emphasis or HTML in the summary.</summary>
    private static string Plain(string text)
    {
        var plain = new StringBuilder(text.Length);
        foreach (var ch in text)
        {
            plain.Append(ch is '[' or ']' or '(' or ')' or '*' or '_' or '`' or '<' or '>' or '#' or '|' or '\\' or '!' ? ' ' : ch);
        }

        return plain.ToString();
    }
}
