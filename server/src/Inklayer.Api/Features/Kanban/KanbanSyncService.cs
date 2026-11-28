using Inklayer.Api.Hosting;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Kanban;

/// <summary>
/// Syncs every kanban connected to a tracker, once a minute: trackers can't reach a server behind a VPN, so the server asks
/// them. "Sync now" on a kanban runs the same sync straight away.
/// </summary>
internal sealed partial class KanbanSyncService(IServiceScopeFactory scopes, FeatureSwitches features, TimeProvider clock, ILogger<KanbanSyncService> logger)
    : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Every, clock);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await RunAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogFailed(logger, ex);
            }
        }
    }

    /// <summary>Syncs each connected kanban in turn. Returns how many were synced.</summary>
    public async Task<int> RunAsync(CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.Kanban, ct) || !await features.IsEnabledAsync(Feature.IssueTrackers, ct)
            || !await features.IsEnabledAsync(Feature.Docs, ct))
        {
            return 0;
        }

        List<Guid> ids;
        await using (var scope = scopes.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            ids = await db.KanbanBoards.AsNoTracking()
                .Where(k => k.TrackerConnectionId != null && db.Docs.Any(d => d.Id == k.DocId && d.DeletedAt == null))
                .Select(k => k.DocId).ToListAsync(ct);
        }

        var synced = 0;
        foreach (var id in ids)
        {
            // A scope each: one kanban's failure, or tracked entities, don't reach the next.
            await using var scope = scopes.CreateAsyncScope();
            if (await scope.ServiceProvider.GetRequiredService<KanbanSync>().SyncAsync(id, ct) is not null)
            {
                synced++;
            }
        }

        return synced;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Syncing kanbans with their trackers failed")]
    private static partial void LogFailed(ILogger logger, Exception ex);
}
