using OpenIddict.Abstractions;

namespace Inklayer.Api.Auth;

/// <summary>Deletes expired and revoked tokens and authorizations once a day so the database doesn't grow without bound.</summary>
internal sealed partial class TokenPruningService(IServiceProvider services, TimeProvider clock, ILogger<TokenPruningService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(24), clock);
        do
        {
            try
            {
                await using var scope = services.CreateAsyncScope();
                var threshold = clock.GetUtcNow().AddDays(-14);
                await scope.ServiceProvider.GetRequiredService<IOpenIddictTokenManager>().PruneAsync(threshold, stoppingToken);
                await scope.ServiceProvider.GetRequiredService<IOpenIddictAuthorizationManager>().PruneAsync(threshold, stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogPruneFailed(logger, ex);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Token pruning failed")]
    private static partial void LogPruneFailed(ILogger logger, Exception exception);
}
