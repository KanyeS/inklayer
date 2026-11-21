using Inklayer.Api.Features.Annotations;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Features.Notifications;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <summary>
/// Keeps comments in step with their issues. Trackers can't reach a server behind a VPN, so this asks them instead, every
/// few minutes: an issue closed in the tracker resolves its comment (with a short reply saying so, and a notification);
/// reopened, it reopens the comment. New comments on the issue are brought into the thread, and the people in it told.
/// </summary>
internal sealed partial class IssueSyncService(IServiceScopeFactory scopes, FeatureSwitches features, TimeProvider clock, ILogger<IssueSyncService> logger) : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromMinutes(5);
    private const int Batch = 50;

    /// <summary>How long after an issue closes its comments are still read.</summary>
    private static readonly TimeSpan CommentsAfterClosing = TimeSpan.FromDays(14);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Every, clock);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await RunOnceAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    LogFailed(logger, ex);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    /// <summary>Checks the issues not checked for a while. Returns how many changed.</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.IssueTrackers, ct))
        {
            return 0;
        }

        await using var scope = scopes.CreateAsyncScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<InklayerDbContext>();
        var trackers = services.GetRequiredService<Trackers>();
        var accounts = services.GetRequiredService<TrackerAccounts>();
        var notifications = services.GetRequiredService<NotificationService>();
        var indexer = services.GetRequiredService<DocIndexer>();

        var issueService = services.GetRequiredService<IssueService>();

        var now = clock.GetUtcNow().UtcDateTime;
        var due = now - Every + TimeSpan.FromSeconds(30);
        var batch = await db.AnnotationIssues.Where(i => i.LastSyncedAt < due).OrderBy(i => i.LastSyncedAt).Take(Batch).ToListAsync(ct);
        var connectionIds = batch.Select(i => i.ConnectionId).Distinct().ToList();
        var connections = await db.IssueTrackerConnections.Where(c => connectionIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);

        var changed = 0;
        // Comments linked to the same issue share it: ask the tracker once.
        foreach (var group in batch.GroupBy(i => (i.ConnectionId, i.ExternalId)))
        {
            var rows = group.ToList();
            var connection = connections[group.Key.ConnectionId];
            var key = $"{TrackerKinds.Name(connection.Kind)} {rows[0].Key}";
            foreach (var row in rows)
            {
                row.LastSyncedAt = now;
            }

            // The shared account, else the account of someone who linked the issue.
            if (await accounts.ForBackgroundAsync(connection, rows.Select(r => r.CreatedByUserId), ct) is not { } token)
            {
                connection.LastError = $"Couldn't check {rows[0].Key}: no one who linked it has a {TrackerKinds.Name(connection.Kind)} account connected, and there's no shared one.";
                connection.LastErrorAt = now;
                continue;
            }

            string state;
            try
            {
                state = await accounts.WithAsync(token, t => trackers.For(connection.Kind).StateAsync(IssueService.SettingsOf(connection), t, group.Key.ExternalId, ct), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                connection.LastError = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
                connection.LastErrorAt = now;
                continue;
            }

            // New comments in the tracker, while the issue is open and for a while after it closes.
            var newComments = new List<IssueComment>();
            var readComments = state == IssueStates.Open || rows.Any(r => r.State == IssueStates.Open || r.ClosedAt > now - CommentsAfterClosing);
            var firstRead = rows.Any(r => r.CommentsCheckedAt is null);
            if (readComments)
            {
                try
                {
                    // A little overlap, for clocks that disagree; known comments are recognised by id.
                    var since = firstRead ? (DateTime?)null : rows.Min(r => r.CommentsCheckedAt)!.Value - TimeSpan.FromMinutes(5);
                    newComments = await issueService.ImportCommentsAsync(connection, group.Key.ExternalId, since, token, ct);
                    foreach (var row in rows)
                    {
                        row.CommentsCheckedAt = now;
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    var message = $"Reading comments on {rows[0].Key}: {ex.Message}";
                    connection.LastError = message.Length > 300 ? message[..300] : message;
                    connection.LastErrorAt = now;
                }
            }

            foreach (var issue in rows)
            {
                var comment = await db.Annotations.SingleOrDefaultAsync(a => a.Id == issue.AnnotationId && a.DeletedAt == null, ct);
                if (comment is not null && !firstRead)
                {
                    // The first read brings in what was said before linking: not news.
                    foreach (var added in newComments)
                    {
                        await notifications.IssueCommentAsync(comment, [.. rows.Select(r => r.CreatedByUserId)], key, added.AuthorName, added.Body, ct);
                    }
                }

                if (state == issue.State)
                {
                    continue;
                }

                issue.State = state;
                issue.ClosedAt = state == IssueStates.Closed ? now : null;
                changed++;
                if (comment is null)
                {
                    continue;
                }

                if (state == IssueStates.Closed && comment.Status == AnnotationStatus.Open)
                {
                    comment.Status = AnnotationStatus.Resolved;
                    comment.ResolvedAt = now;
                    comment.ResolvedByUserId = issue.CreatedByUserId;
                    comment.Version++;
                    comment.UpdatedAt = now;
                    db.AnnotationRevisions.Add(AnnotationEndpoints.Revision(comment, AnnotationActions.Resolved, issue.CreatedByUserId, now));
                    db.AnnotationReplies.Add(new AnnotationReply
                    {
                        AnnotationId = comment.Id, AuthorUserId = issue.CreatedByUserId, Body = $"Closed in {key}.", CreatedAt = now, UpdatedAt = now,
                    });
                    await db.SaveChangesAsync(ct);
                    await notifications.IssueClosedAsync(comment, issue.CreatedByUserId, key, ct);
                }
                else if (state == IssueStates.Open && comment.Status == AnnotationStatus.Resolved)
                {
                    comment.Status = AnnotationStatus.Open;
                    comment.ResolvedAt = null;
                    comment.ResolvedByUserId = null;
                    comment.Version++;
                    comment.UpdatedAt = now;
                    db.AnnotationRevisions.Add(AnnotationEndpoints.Revision(comment, AnnotationActions.Reopened, issue.CreatedByUserId, now));
                }

                await indexer.IndexCommentAsync(comment, ct);
            }
        }

        await db.SaveChangesAsync(ct);
        return changed;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking linked issues failed")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
