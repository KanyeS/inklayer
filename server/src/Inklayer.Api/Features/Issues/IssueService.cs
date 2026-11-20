using System.ComponentModel.DataAnnotations;
using System.Text;
using System.Text.Json;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Annotations;
using Inklayer.Api.Features.Notifications;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Inklayer.Domain.Notifications;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

public sealed record IssueResponse(
    Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind, string Key, string Url,
    [property: AllowedValues(IssueStates.Open, IssueStates.Closed)] string State);

/// <summary>A comment on a linked issue, written in the tracker, shown in the Inklayer thread.</summary>
public sealed record IssueCommentResponse(
    Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind,
    string IssueKey, string IssueUrl, string AuthorName, string? AuthorUrl, string Body, DateTime CreatedAt, DateTime UpdatedAt);

/// <summary>Issues made from comments: creating them with everything a developer needs, and closing them when comments are resolved.</summary>
internal sealed class IssueService(
    InklayerDbContext db, Trackers trackers, IntegrationSecrets secrets, NotificationService notifications, IHttpContextAccessor http, IConfiguration configuration,
    FeatureSwitches features, TimeProvider clock)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static TrackerSettings SettingsOf(IssueTrackerConnection c) => JsonSerializer.Deserialize<TrackerSettings>(c.Settings, Json)!;

    public static string SettingsJson(TrackerSettings s) => JsonSerializer.Serialize(s, Json);

    public async Task<AnnotationIssue> CreateAsync(Annotation comment, IssueTrackerConnection connection, string? title, Guid actorUserId, CancellationToken ct)
    {
        var markdown = await IssueBodyAsync(comment, ct);
        var plainBody = markdown.Split('\n')[0];
        var issueTitle = (title?.Trim() is { Length: > 0 } t ? t : plainBody.Length > 0 ? plainBody : $"Comment on {Shorten(comment.PageUrl)}");
        issueTitle = issueTitle.Length > 120 ? issueTitle[..119] + "…" : issueTitle;

        var created = await trackers.For(connection.Kind).CreateAsync(SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), issueTitle, markdown, ct);
        var now = clock.GetUtcNow().UtcDateTime;
        var issue = new AnnotationIssue
        {
            AnnotationId = comment.Id, ConnectionId = connection.Id, ExternalId = created.ExternalId, Key = created.Key, Url = created.Url,
            CreatedByUserId = actorUserId, CreatedAt = now, LastSyncedAt = now, CommentsCheckedAt = now,
        };
        db.AnnotationIssues.Add(issue);
        await db.SaveChangesAsync(ct);
        await notifications.IssueCreatedAsync(comment, actorUserId, $"{TrackerKinds.Name(connection.Kind)} {issue.Key}", issue.Url, ct);
        return issue;
    }

    /// <summary>Looks up the issue a pasted address or number points to.</summary>
    public Task<FoundIssue> FindAsync(IssueTrackerConnection connection, string reference, CancellationToken ct) =>
        trackers.For(connection.Kind).GetAsync(SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), reference, ct);

    public Task<IReadOnlyList<FoundIssue>> SearchAsync(IssueTrackerConnection connection, string query, CancellationToken ct) =>
        trackers.For(connection.Kind).SearchAsync(SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), query, ct);

    /// <summary>
    /// Links an issue that already exists to the comment. With <paramref name="addComment"/>, posts the comment (with its
    /// replies, page and details) on the issue first, so the issue has the context. Brings in the issue's comments so far.
    /// </summary>
    public async Task<AnnotationIssue> LinkAsync(
        Annotation comment, IssueTrackerConnection connection, FoundIssue found, bool addComment, Guid actorUserId, CancellationToken ct)
    {
        var tracker = trackers.For(connection.Kind);
        var settings = SettingsOf(connection);
        var token = secrets.Unprotect(connection.ProtectedToken);
        var now = clock.GetUtcNow().UtcDateTime;
        if (addComment)
        {
            var note = $"**Linked from Inklayer**\n\n{await IssueBodyAsync(comment, ct)}";
            var noteId = await tracker.AddCommentAsync(settings, token, found.ExternalId, note, ct);
            await AddPostedAsync(connection.Id, found.ExternalId, noteId, actorUserId, note, null, now, ct);
        }

        var issue = new AnnotationIssue
        {
            AnnotationId = comment.Id, ConnectionId = connection.Id, ExternalId = found.ExternalId, Key = found.Key, Url = found.Url, State = found.State,
            ClosedAt = found.State == IssueStates.Closed ? now : null, Linked = true, CreatedByUserId = actorUserId, CreatedAt = now, LastSyncedAt = now,
        };
        db.AnnotationIssues.Add(issue);
        await db.SaveChangesAsync(ct);

        try
        {
            await ImportCommentsAsync(connection, found.ExternalId, null, ct);
            issue.CommentsCheckedAt = now;
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Linked all the same; the next sync tries again.
            connection.LastError = Clip($"Reading comments on {found.Key}: {ex.Message}");
            connection.LastErrorAt = now;
            await db.SaveChangesAsync(ct);
        }

        await notifications.IssueCreatedAsync(comment, actorUserId, $"{TrackerKinds.Name(connection.Kind)} {issue.Key}", issue.Url, ct, linked: true);
        return issue;
    }

    /// <summary>
    /// Fetches the issue's comments changed since <paramref name="since"/> and stores them: new ones are added, edited
    /// ones updated. Comments Inklayer posted are recognised by their id and skipped. Returns the new ones.
    /// </summary>
    public async Task<List<IssueComment>> ImportCommentsAsync(IssueTrackerConnection connection, string issueExternalId, DateTime? since, CancellationToken ct)
    {
        var fetched = await trackers.For(connection.Kind).CommentsAsync(SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), issueExternalId, since, ct);
        if (fetched.Count == 0)
        {
            return [];
        }

        var ids = fetched.Select(c => c.ExternalId).ToList();
        var known = await db.IssueComments.Where(c => c.ConnectionId == connection.Id && c.IssueExternalId == issueExternalId && ids.Contains(c.ExternalId))
            .ToDictionaryAsync(c => c.ExternalId, ct);
        var added = new List<IssueComment>();
        foreach (var c in fetched)
        {
            var body = Clip(c.Body, 20_000);
            if (known.TryGetValue(c.ExternalId, out var existing))
            {
                if (!existing.FromInklayer && (existing.Body != body || existing.UpdatedAt != c.UpdatedAt))
                {
                    existing.Body = body;
                    existing.AuthorName = Clip(c.AuthorName, 200);
                    existing.UpdatedAt = c.UpdatedAt;
                }

                continue;
            }

            var comment = new IssueComment
            {
                ConnectionId = connection.Id, IssueExternalId = issueExternalId, ExternalId = c.ExternalId, AuthorName = Clip(c.AuthorName, 200),
                AuthorUrl = c.AuthorUrl is { Length: <= 500 } url ? url : null, Body = body, CreatedAt = c.CreatedAt, UpdatedAt = c.UpdatedAt,
            };
            db.IssueComments.Add(comment);
            added.Add(comment);
        }

        await db.SaveChangesAsync(ct);
        return added;
    }

    /// <summary>
    /// A reply was written in Inklayer: post it on the comment's linked issues, where the connection says to. Failures are
    /// noted on the connection; the reply stands either way.
    /// </summary>
    public async Task ReplyAddedAsync(Annotation comment, AnnotationReply reply, CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.IssueTrackers, ct))
        {
            return;
        }

        var linked = await (from i in db.AnnotationIssues
                            where i.AnnotationId == comment.Id
                            join c in db.IssueTrackerConnections on i.ConnectionId equals c.Id
                            where c.PostRepliesToIssue
                            select new { Issue = i, Connection = c }).ToListAsync(ct);
        if (linked.Count == 0)
        {
            return;
        }

        var people = Mentions.Extract(reply.Body).Append(reply.AuthorUserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var text = $"**{names.GetValueOrDefault(reply.AuthorUserId, "Someone")}** (via Inklayer): {Mentions.ToNames(reply.Body, names).Trim()}\n\n" +
            $"[View in Inklayer]({Origin()}/comments/{comment.Id})";
        foreach (var link in linked.DistinctBy(l => (l.Issue.ConnectionId, l.Issue.ExternalId)))
        {
            var now = clock.GetUtcNow().UtcDateTime;
            try
            {
                var id = await trackers.For(link.Connection.Kind).AddCommentAsync(
                    SettingsOf(link.Connection), secrets.Unprotect(link.Connection.ProtectedToken), link.Issue.ExternalId, text, ct);
                await AddPostedAsync(link.Connection.Id, link.Issue.ExternalId, id, reply.AuthorUserId, text, reply.Id, now, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                link.Connection.LastError = Clip($"Posting a reply on {link.Issue.Key}: {ex.Message}");
                link.Connection.LastErrorAt = now;
            }
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>Remembers a comment Inklayer posted, so syncing doesn't show it again as the tracker's.</summary>
    private async Task AddPostedAsync(Guid connectionId, string issueExternalId, string externalId, Guid authorUserId, string body, Guid? replyId, DateTime now, CancellationToken ct)
    {
        var name = await db.Users.Where(u => u.Id == authorUserId).Select(u => u.PreferredName ?? u.DisplayName).SingleOrDefaultAsync(ct) ?? "Inklayer";
        db.IssueComments.Add(new IssueComment
        {
            ConnectionId = connectionId, IssueExternalId = issueExternalId, ExternalId = externalId, AuthorName = Clip(name, 200), Body = Clip(body, 20_000),
            CreatedAt = now, UpdatedAt = now, FromInklayer = true, ReplyId = replyId,
        });
    }

    /// <summary>The comment was resolved in Inklayer: close its open issues where the connection says to. Failures are noted on the connection.</summary>
    public async Task CommentResolvedAsync(Annotation comment, CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.IssueTrackers, ct))
        {
            return;
        }

        var open = await db.AnnotationIssues.Where(i => i.AnnotationId == comment.Id && i.State == IssueStates.Open).ToListAsync(ct);
        foreach (var issue in open)
        {
            var connection = await db.IssueTrackerConnections.SingleOrDefaultAsync(c => c.Id == issue.ConnectionId, ct);
            if (connection is not { CloseIssueOnResolve: true })
            {
                continue;
            }

            // Several comments can share an issue: it closes with the last of them.
            var othersOpen = await (from i in db.AnnotationIssues
                                    where i.ConnectionId == issue.ConnectionId && i.ExternalId == issue.ExternalId && i.AnnotationId != comment.Id
                                    join a in db.Annotations on i.AnnotationId equals a.Id
                                    where a.DeletedAt == null && a.Status == AnnotationStatus.Open
                                    select i.Id).AnyAsync(ct);
            if (othersOpen)
            {
                continue;
            }

            try
            {
                await trackers.For(connection.Kind).CloseAsync(SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), issue.ExternalId, ct);
                issue.State = IssueStates.Closed;
                issue.LastSyncedAt = clock.GetUtcNow().UtcDateTime;
                issue.ClosedAt = issue.LastSyncedAt;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                connection.LastError = Clip($"Closing {issue.Key}: {ex.Message}");
                connection.LastErrorAt = clock.GetUtcNow().UtcDateTime;
            }
        }

        await db.SaveChangesAsync(ct);
    }

    public static async Task<Dictionary<Guid, List<IssueResponse>>> ForAsync(InklayerDbContext db, List<Guid> annotationIds, CancellationToken ct)
    {
        var rows = await (from i in db.AnnotationIssues.AsNoTracking()
                          where annotationIds.Contains(i.AnnotationId)
                          join c in db.IssueTrackerConnections on i.ConnectionId equals c.Id
                          orderby i.CreatedAt
                          select new { i.AnnotationId, Issue = new IssueResponse(i.Id, c.Kind, i.Key, i.Url, i.State) }).ToListAsync(ct);
        return rows.GroupBy(r => r.AnnotationId).ToDictionary(g => g.Key, g => g.Select(r => r.Issue).ToList());
    }

    /// <summary>The tracker's comments on each comment's linked issues, oldest first; not the ones Inklayer posted.</summary>
    public static async Task<Dictionary<Guid, List<IssueCommentResponse>>> CommentsForAsync(InklayerDbContext db, List<Guid> annotationIds, CancellationToken ct)
    {
        var rows = await (from i in db.AnnotationIssues.AsNoTracking()
                          where annotationIds.Contains(i.AnnotationId)
                          join c in db.IssueTrackerConnections on i.ConnectionId equals c.Id
                          join ic in db.IssueComments.AsNoTracking() on new { i.ConnectionId, IssueExternalId = i.ExternalId } equals new { ic.ConnectionId, ic.IssueExternalId }
                          where !ic.FromInklayer
                          select new
                          {
                              i.AnnotationId,
                              Comment = new IssueCommentResponse(ic.Id, c.Kind, i.Key, i.Url, ic.AuthorName, ic.AuthorUrl, ic.Body, ic.CreatedAt, ic.UpdatedAt),
                          }).ToListAsync(ct);
        return rows.GroupBy(r => r.AnnotationId).ToDictionary(g => g.Key, g => g.Select(r => r.Comment).OrderBy(c => c.CreatedAt).ToList());
    }

    /// <summary>The comment, its replies, where it is, and the page details: what a developer needs to pick it up.</summary>
    private async Task<string> IssueBodyAsync(Annotation comment, CancellationToken ct)
    {
        var replies = await db.AnnotationReplies.AsNoTracking().Where(r => r.AnnotationId == comment.Id && r.DeletedAt == null).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        var people = replies.Select(r => r.AuthorUserId).Append(comment.AuthorUserId).Concat(Mentions.Extract(comment.Body))
            .Concat(replies.SelectMany(r => Mentions.Extract(r.Body))).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var context = await db.AnnotationContexts.AsNoTracking().SingleOrDefaultAsync(c => c.AnnotationId == comment.Id, ct);
        var origin = Origin();

        var body = new StringBuilder();
        body.AppendLine(Mentions.ToNames(comment.Body, names).Trim());
        body.AppendLine();
        body.AppendLine($"**Page:** {comment.PageUrl}");
        body.AppendLine($"**Reported by:** {names.GetValueOrDefault(comment.AuthorUserId, "someone")} in Inklayer: {origin}/comments/{comment.Id}");
        if (replies.Count > 0)
        {
            body.AppendLine();
            body.AppendLine("**Replies:**");
            foreach (var reply in replies)
            {
                body.AppendLine($"- {names.GetValueOrDefault(reply.AuthorUserId, "someone")}: {Mentions.ToNames(reply.Body, names).Replace('\n', ' ')}");
            }
        }

        if (context is not null)
        {
            var c = ContextEndpoints.ToResponse(context);
            body.AppendLine();
            body.AppendLine($"**Browser:** {c.Browser} on {c.Os}, {c.ViewportWidth}×{c.ViewportHeight} @{c.DevicePixelRatio}x{(c.Zoom is { } z && Math.Abs(z - 1) > 0.01 ? $", zoomed to {Math.Round(z * 100)}%" : "")}");
            if (c.Selector.Length > 0)
            {
                body.AppendLine($"**Element:** `{c.Selector}`");
            }

            foreach (var e in c.Console.Take(10))
            {
                body.AppendLine($"- console.{e.Level}: {e.Message}");
            }

            foreach (var n in c.Network.Take(10))
            {
                body.AppendLine($"- {n.Method} {n.Url} → {(n.Status == 0 ? "failed" : n.Status)}");
            }

            if (await db.AnnotationScreenshots.AnyAsync(s => s.AnnotationId == comment.Id, ct))
            {
                body.AppendLine($"**Screenshot:** {origin}/comments/{comment.Id}");
            }
        }

        return body.ToString().TrimEnd();
    }

    private static string Shorten(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host + u.AbsolutePath : url;

    private string Origin() => http.HttpContext is { } h ? McpResource.Origin(h.Request) : (configuration["Inklayer:PublicUrl"] ?? "").TrimEnd('/');

    private static string Clip(string text, int max = 300) => text.Length > max ? text[..(max - 1)] + "…" : text;
}
