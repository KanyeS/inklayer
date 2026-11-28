using Inklayer.Api.Features.Notifications;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Kanban;

/// <summary>
/// Reminds people of their tasks' due dates: once on the day a task is due, and once when it's past due, unless it's done by
/// then. Dates are days in UTC. Runs every hour; a task whose due date changes is reminded of the new one.
/// </summary>
internal sealed partial class TaskDueService(IServiceScopeFactory scopes, FeatureSwitches features, TimeProvider clock, ILogger<TaskDueService> logger) : BackgroundService
{
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);
    private const int Batch = 200;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // A little after starting, then every hour.
        try
        {
            await Task.Delay(TimeSpan.FromMinutes(1), clock, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        using var timer = new PeriodicTimer(Every, clock);
        do
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
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>Sends the reminders due now. Returns how many tasks were reminded about.</summary>
    public async Task<int> RunAsync(CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.Docs, ct) || !await features.IsEnabledAsync(Feature.Kanban, ct))
        {
            return 0;
        }

        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var notifications = scope.ServiceProvider.GetRequiredService<NotificationService>();
        var today = DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);
        var reminded = 0;
        while (true)
        {
            var tasks = await db.KanbanTasks.Include(t => t.Assignees)
                .Where(t => t.Due != null && t.Category != KanbanCategories.Done && t.Assignees.Any()
                    && db.Docs.Any(d => d.Id == t.DocId && d.DeletedAt == null)
                    && ((t.Due == today && t.DueRemindedFor != t.Due) || (t.Due < today && t.OverdueRemindedFor != t.Due)))
                .Take(Batch).ToListAsync(ct);
            if (tasks.Count == 0)
            {
                return reminded;
            }

            var docIds = tasks.Select(t => t.DocId).Distinct().ToList();
            var docs = await db.Docs.Where(d => docIds.Contains(d.Id)).ToDictionaryAsync(d => d.Id, ct);
            foreach (var task in tasks)
            {
                var overdue = task.Due < today;
                // Marked first: a failure to notify shouldn't send it again every hour.
                if (overdue)
                {
                    task.OverdueRemindedFor = task.Due;
                    task.DueRemindedFor = task.Due; // past the day: no "due today" any more
                }
                else
                {
                    task.DueRemindedFor = task.Due;
                }

                await db.SaveChangesAsync(ct);
                await notifications.TaskDueAsync(docs[task.DocId], task, overdue, ct);
                reminded++;
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Sending task due-date reminders failed")]
    private static partial void LogFailed(ILogger logger, Exception ex);
}
