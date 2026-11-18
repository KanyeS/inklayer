using System.Text.Json;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using OpenIddict.Abstractions;
using OpenIddict.EntityFrameworkCore.Models;

namespace Inklayer.Api.Auth;

/// <summary>
/// Once a day, deletes expired and revoked tokens and authorizations, and apps that registered themselves but that nobody
/// allowed (or everyone disconnected), so the database doesn't grow without bound.
/// </summary>
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
                await PruneUnusedAppsAsync(scope.ServiceProvider, clock.GetUtcNow().AddDays(-1), stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                LogPruneFailed(logger, ex);
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    /// <summary>Self-registered apps older than <paramref name="before"/> with no authorization left.</summary>
    internal static async Task PruneUnusedAppsAsync(IServiceProvider services, DateTimeOffset before, CancellationToken ct)
    {
        var db = services.GetRequiredService<InklayerDbContext>();
        var manager = services.GetRequiredService<IOpenIddictApplicationManager>();
        var unused = await db.Set<OpenIddictEntityFrameworkCoreApplication>()
            .Where(a => a.ClientId != null && a.ClientId.StartsWith(McpResource.DynamicClientPrefix)
                && !db.Set<OpenIddictEntityFrameworkCoreAuthorization>().Any(z => z.Application!.Id == a.Id && z.Status == OpenIddictConstants.Statuses.Valid))
            .ToListAsync(ct);
        foreach (var app in unused)
        {
            var properties = await manager.GetPropertiesAsync(app, ct);
            var created = properties.TryGetValue(ClientRegistrationEndpoints.CreatedProperty, out var value) ? value.Deserialize<DateTimeOffset>() : DateTimeOffset.MinValue;
            if (created < before)
            {
                await manager.DeleteAsync(app, ct);
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Token pruning failed")]
    private static partial void LogPruneFailed(ILogger logger, Exception exception);
}
