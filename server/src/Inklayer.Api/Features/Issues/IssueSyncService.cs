using System.Collections.Concurrent;
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
/// <list type="bullet">
/// <item>Every 5 minutes, everything due, in batches: open issues (and those closed in the last 14 days) every 5 minutes,
/// older closed ones once a day, which still notices one being reopened.</item>
/// <item>Every 30 seconds, the issues of comments someone is looking at (<see cref="Want"/>), at most once a minute each,
/// so what's on screen keeps up.</item>
/// </list>
/// </summary>
internal sealed partial class IssueSyncService(IServiceScopeFactory scopes, FeatureSwitches features, TimeProvider clock, ILogger<IssueSyncService> logger) : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromMinutes(5);
    private const int Batch = 50;

    /// <summary>Batches in one round at most (2,500 issues): the rest wait for the next round.</summary>
    private const int MaxBatches = 50;

    /// <summary>Between batches, to go easy on the trackers' rate limits.</summary>
    private static readonly TimeSpan BatchPause = TimeSpan.FromSeconds(1);

    /// <summary>Issues closed longer than this are checked once a day.</summary>
    private static readonly TimeSpan RecentlyClosed = TimeSpan.FromDays(14);

    private static readonly TimeSpan OldClosedEvery = TimeSpan.FromDays(1);

    /// <summary>How often the issues people are looking at are checked, and how soon one is checked again.</summary>
    private static readonly TimeSpan WantedEvery = TimeSpan.FromSeconds(30);

    private static readonly TimeSpan WantedAgain = TimeSpan.FromMinutes(1);

    private const int MaxWanted = 5000;

    /// <summary>Issues of comments being looked at, to check soon.</summary>
    private readonly ConcurrentDictionary<Guid, byte> wanted = new();

    /// <summary>One check at a time: the round and the quick checks don't step on each other.</summary>
    private readonly SemaphoreSlim running = new(1, 1);

    /// <summary>
    /// Someone is looking at these comments: check their issues (open ones, and those closed lately) within about a minute.
    /// </summary>
    public async Task WantForCommentsAsync(InklayerDbContext db, IReadOnlyCollection<Guid> annotationIds, CancellationToken ct)
    {
        if (annotationIds.Count == 0 || wanted.Count >= MaxWanted)
        {
            return;
        }

        var recent = clock.GetUtcNow().UtcDateTime - RecentlyClosed;
        Want(await db.AnnotationIssues.AsNoTracking()
            .Where(i => annotationIds.Contains(i.AnnotationId) && (i.State == IssueStates.Open || i.ClosedAt > recent))
            .Select(i => i.Id).ToListAsync(ct));
    }

    /// <summary>Someone is looking at comments linked to these issues: check them within about a minute.</summary>
    public void Want(IEnumerable<Guid> issueIds)
    {
        foreach (var id in issueIds)
        {
            if (wanted.Count >= MaxWanted)
            {
                break;
            }

            wanted.TryAdd(id, 0);
        }
    }

    /// <summary>How long after an issue closes its comments are still read.</summary>
    private static readonly TimeSpan CommentsAfterClosing = TimeSpan.FromDays(14);

    protected override Task ExecuteAsync(CancellationToken stoppingToken) =>
        Task.WhenAll(EveryAsync(Every, RunOnceAsync, stoppingToken), EveryAsync(WantedEvery, RunWantedAsync, stoppingToken));

    private async Task EveryAsync(TimeSpan every, Func<CancellationToken, Task<int>> run, CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(every, clock);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await run(stoppingToken);
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

    /// <summary>Checks everything due, in batches. Returns how many changed.</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        var changed = 0;
        for (var round = 0; round < MaxBatches; round++)
        {
            var (count, batchChanged) = await CheckAsync(async (db, now) =>
            {
                var fresh = now - Every + TimeSpan.FromSeconds(30);
                var daily = now - OldClosedEvery + TimeSpan.FromSeconds(30);
                var recent = now - RecentlyClosed;
                return await db.AnnotationIssues
                    .Where(i => i.State == IssueStates.Open || i.ClosedAt > recent ? i.LastSyncedAt < fresh : i.LastSyncedAt < daily)
                    .OrderBy(i => i.LastSyncedAt).Take(Batch).ToListAsync(ct);
            }, ct);
            changed += batchChanged;
            if (count < Batch)
            {
                break;
            }

            await Task.Delay(BatchPause, clock, ct);
        }

        return changed;
    }

    /// <summary>Checks the issues people are looking at (<see cref="Want"/>) that weren't checked in the last minute.</summary>
    public async Task<int> RunWantedAsync(CancellationToken ct)
    {
        var ids = wanted.Keys.ToList();
        foreach (var id in ids)
        {
            wanted.TryRemove(id, out _);
        }

        if (ids.Count == 0)
        {
            return 0;
        }

        var (_, changed) = await CheckAsync(async (db, now) =>
        {
            var again = now - WantedAgain;
            var picked = await db.AnnotationIssues.Where(i => ids.Contains(i.Id) && i.LastSyncedAt < again)
                .Select(i => new { i.ConnectionId, i.ExternalId }).Distinct().Take(Batch).ToListAsync(ct);
            if (picked.Count == 0)
            {
                return [];
            }

            // With every comment linked to the same issues, so they move together.
            var connectionIds = picked.Select(p => p.ConnectionId).Distinct().ToList();
            var externalIds = picked.Select(p => p.ExternalId).Distinct().ToList();
            var rows = await db.AnnotationIssues.Where(i => connectionIds.Contains(i.ConnectionId) && externalIds.Contains(i.ExternalId)).ToListAsync(ct);
            return [.. rows.Where(r => picked.Any(p => p.ConnectionId == r.ConnectionId && p.ExternalId == r.ExternalId))];
        }, ct);
        return changed;
    }

    /// <summary>Checks the issues <paramref name="select"/> picks. Returns how many it picked, and how many changed.</summary>
    private async Task<(int Count, int Changed)> CheckAsync(Func<InklayerDbContext, DateTime, Task<List<AnnotationIssue>>> select, CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.IssueTrackers, ct))
        {
            return (0, 0);
        }

        await running.WaitAsync(ct);
        try
        {
            return await CheckCoreAsync(select, ct);
        }
        finally
        {
            running.Release();
        }
    }

    private async Task<(int Count, int Changed)> CheckCoreAsync(Func<InklayerDbContext, DateTime, Task<List<AnnotationIssue>>> select, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var services = scope.ServiceProvider;
        var db = services.GetRequiredService<InklayerDbContext>();
        var trackers = services.GetRequiredService<Trackers>();
        var accounts = services.GetRequiredService<TrackerAccounts>();
        var notifications = services.GetRequiredService<NotificationService>();
        var indexer = services.GetRequiredService<DocIndexer>();

        var issueService = services.GetRequiredService<IssueService>();

        var now = clock.GetUtcNow().UtcDateTime;
        var batch = await select(db, now);
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
                state = IssueService.IsPullRequest(group.Key.ExternalId)
                    ? await accounts.WithAsync(token, t => ((IPullRequests)trackers.For(connection.Kind)).PullRequestStateAsync(
                        IssueService.SettingsOf(connection), t, IssueService.PullRequestNumber(group.Key.ExternalId), ct), ct)
                    : await accounts.WithAsync(token, t => trackers.For(connection.Kind).StateAsync(IssueService.SettingsOf(connection), t, group.Key.ExternalId, ct), ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                connection.LastError = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
                connection.LastErrorAt = now;
                continue;
            }

            // New comments in the tracker, while the issue is open and for a while after it closes.
            var newComments = new List<IssueComment>();
            // Pull requests' conversations stay in the tracker: only their state is followed.
            var pullRequest = IssueService.IsPullRequest(group.Key.ExternalId);
            var readComments = !pullRequest && (state == IssueStates.Open || rows.Any(r => r.State == IssueStates.Open || r.ClosedAt > now - CommentsAfterClosing));
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
                issue.ClosedAt = state == IssueStates.Open ? null : now;
                changed++;
                if (comment is null)
                {
                    continue;
                }

                // An issue closing resolves its comment; a pull request only when it's merged, not closed unmerged.
                if ((pullRequest ? state == IssueStates.Merged : state == IssueStates.Closed) && comment.Status == AnnotationStatus.Open)
                {
                    comment.Status = AnnotationStatus.Resolved;
                    comment.ResolvedAt = now;
                    comment.ResolvedByUserId = issue.CreatedByUserId;
                    comment.Version++;
                    comment.UpdatedAt = now;
                    db.AnnotationRevisions.Add(AnnotationEndpoints.Revision(comment, AnnotationActions.Resolved, issue.CreatedByUserId, now));
                    db.AnnotationReplies.Add(new AnnotationReply
                    {
                        AnnotationId = comment.Id, AuthorUserId = issue.CreatedByUserId, Body = pullRequest ? $"Merged in {key}." : $"Closed in {key}.", CreatedAt = now, UpdatedAt = now,
                    });
                    await db.SaveChangesAsync(ct);
                    await notifications.IssueClosedAsync(comment, issue.CreatedByUserId, key, ct);
                }
                else if (!pullRequest && state == IssueStates.Open && comment.Status == AnnotationStatus.Resolved)
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

            // Merging resolved comments: the pull request's summary says so.
            if (pullRequest && rows.Any(r => r.InSummary))
            {
                await db.SaveChangesAsync(ct);
                await issueService.UpdateSummaryAsync(connection, group.Key.ExternalId, null, ct);
            }
        }

        await db.SaveChangesAsync(ct);
        return (batch.Count, changed);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking linked issues failed")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
