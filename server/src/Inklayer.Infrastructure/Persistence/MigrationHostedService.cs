using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Inklayer.Infrastructure.Persistence;

/// <summary>Applies pending migrations before the server starts accepting requests.</summary>
internal sealed partial class MigrationHostedService(
    IServiceProvider services,
    IOptions<DatabaseOptions> options,
    ILogger<MigrationHostedService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!options.Value.MigrateOnStartup)
        {
            LogSkipped(logger);
            return;
        }

        await using var scope = services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var pending = (await db.Database.GetPendingMigrationsAsync(cancellationToken)).ToList();
        if (pending.Count > 0)
        {
            LogApplying(logger, pending.Count);
        }

        // Always run: on a fresh install this also creates the SQLite file and the migrations history table.
        await db.Database.MigrateAsync(cancellationToken);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    [LoggerMessage(Level = LogLevel.Information, Message = "Database:MigrateOnStartup is false; skipping migrations")]
    private static partial void LogSkipped(ILogger logger);

    [LoggerMessage(Level = LogLevel.Information, Message = "Applying {Count} pending database migration(s)")]
    private static partial void LogApplying(ILogger logger, int count);
}
