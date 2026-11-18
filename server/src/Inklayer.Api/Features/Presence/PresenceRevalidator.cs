using System.Net;
using Inklayer.Api.Network;
using Inklayer.Domain.Network;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Presence;

/// <summary>
/// Presence connections stay open for hours, so they are checked again while open:
/// <list type="bullet">
/// <item>every few minutes, against the user's account (disabled, or signed out everywhere: closed) and organisations
/// (rooms they lost access to are left, new ones joined);</item>
/// <item>straight away when an administrator changes the network allow list (connections from outside it are closed).</item>
/// </list>
/// </summary>
internal sealed partial class PresenceRevalidator(
    PresenceRegistry registry,
    NetworkAccess network,
    IServiceScopeFactory scopes,
    IOptions<PresenceOptions> options,
    TimeProvider clock,
    ILogger<PresenceRevalidator> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        network.Changed += CloseOutsideNetwork;
        try
        {
            using var timer = new PeriodicTimer(options.Value.RevalidateEvery, clock);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await RevalidateAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    LogRevalidationFailed(logger, ex);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
        finally
        {
            network.Changed -= CloseOutsideNetwork;
        }
    }

    public async Task RevalidateAsync(CancellationToken ct)
    {
        var connections = registry.All();
        if (connections.Count == 0)
        {
            return;
        }

        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        foreach (var byUser in connections.GroupBy(c => c.Peer.UserId))
        {
            var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == byUser.Key, ct);
            var organizations = user is { IsDisabled: false } ? await PresenceHub.OrganizationsAsync(user, db, ct) : null;
            foreach (var connection in byUser)
            {
                if (organizations is null || !string.Equals(user!.SecurityStamp, connection.SecurityStamp, StringComparison.Ordinal))
                {
                    connection.Context.Abort();
                    continue;
                }

                await registry.SetOrganizationsAsync(connection, organizations);
            }
        }
    }

    private void CloseOutsideNetwork(IpAllowList list)
    {
        if (network.RestrictionDisabled)
        {
            return;
        }

        foreach (var connection in registry.All())
        {
            if (!(connection.Address is { } address && IPAddress.IsLoopback(address)) && !list.Allows(connection.Address))
            {
                connection.Context.Abort();
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking presence connections failed")]
    private static partial void LogRevalidationFailed(ILogger logger, Exception exception);
}
