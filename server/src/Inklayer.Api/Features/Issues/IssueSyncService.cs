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
/// reopened, it reopens the comment.
/// </summary>
internal sealed partial class IssueSyncService(IServiceScopeFactory scopes, FeatureSwitches features, TimeProvider clock, ILogger<IssueSyncService> logger) : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromMinutes(5);
    private const int Batch = 50;

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
        var secrets = services.GetRequiredService<IntegrationSecrets>();
        var notifications = services.GetRequiredService<NotificationService>();
        var indexer = services.GetRequiredService<DocIndexer>();

        var now = clock.GetUtcNow().UtcDateTime;
        var due = now - Every + TimeSpan.FromSeconds(30);
        var issues = await db.AnnotationIssues.Where(i => i.LastSyncedAt < due).OrderBy(i => i.LastSyncedAt).Take(Batch).ToListAsync(ct);
        var connectionIds = issues.Select(i => i.ConnectionId).Distinct().ToList();
        var connections = await db.IssueTrackerConnections.Where(c => connectionIds.Contains(c.Id)).ToDictionaryAsync(c => c.Id, ct);

        var changed = 0;
        foreach (var issue in issues)
        {
            issue.LastSyncedAt = now;
            var connection = connections[issue.ConnectionId];
            string state;
            try
            {
                state = await trackers.For(connection.Kind).StateAsync(IssueService.SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), issue.ExternalId, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                connection.LastError = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
                connection.LastErrorAt = now;
                continue;
            }

            if (state == issue.State)
            {
                continue;
            }

            issue.State = state;
            changed++;
            var comment = await db.Annotations.SingleOrDefaultAsync(a => a.Id == issue.AnnotationId && a.DeletedAt == null, ct);
            if (comment is null)
            {
                continue;
            }

            var tracker = TrackerKinds.Name(connection.Kind);
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
                    AnnotationId = comment.Id, AuthorUserId = issue.CreatedByUserId, Body = $"Closed in {tracker} {issue.Key}.", CreatedAt = now, UpdatedAt = now,
                });
                await db.SaveChangesAsync(ct);
                await notifications.IssueClosedAsync(comment, issue.CreatedByUserId, $"{tracker} {issue.Key}", ct);
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

        await db.SaveChangesAsync(ct);
        return changed;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking linked issues failed")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
