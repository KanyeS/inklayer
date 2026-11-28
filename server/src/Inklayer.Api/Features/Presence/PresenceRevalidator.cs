using System.Net;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Hosting;
using Inklayer.Api.Network;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Network;
using Microsoft.AspNetCore.SignalR;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Presence;

/// <summary>
/// Live connections (presence and docs) stay open for hours, so they are checked again while open:
/// <list type="bullet">
/// <item>every few minutes, against the user's account (disabled, or signed out everywhere: closed) and organisations
/// (presence rooms they lost access to are left, new ones joined; docs they can no longer see are closed, and edit
/// rights follow their role);</item>
/// <item>straight away when an administrator changes the network allow list (connections from outside it are closed).</item>
/// </list>
/// </summary>
internal sealed partial class PresenceRevalidator(
    PresenceRegistry registry,
    DocsRegistry docs,
    IHubContext<DocsHub> docsHub,
    NetworkAccess network,
    FeatureSwitches features,
    IServiceScopeFactory scopes,
    IOptions<PresenceOptions> options,
    TimeProvider clock,
    ILogger<PresenceRevalidator> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        network.Changed += CloseOutsideNetwork;
        features.Changed += CloseTurnedOff;
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
            features.Changed -= CloseTurnedOff;
        }
    }

    public async Task RevalidateAsync(CancellationToken ct)
    {
        await RevalidatePresenceAsync(ct);
        await RevalidateDocsAsync(ct);
    }

    private async Task RevalidateDocsAsync(CancellationToken ct)
    {
        var connections = docs.All();
        if (connections.Count == 0)
        {
            return;
        }

        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        foreach (var connection in connections)
        {
            var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == connection.Peer.UserId, ct);
            if (user is not { IsDisabled: false } || !string.Equals(user.SecurityStamp, connection.SecurityStamp, StringComparison.Ordinal))
            {
                connection.Context.Abort();
                continue;
            }

            foreach (var (docId, open) in connection.Docs)
            {
                // A doc deleted while it's open isn't closed here (its page says so); losing the organisation or the share is.
                var access = await Inklayer.Api.Access.DocAccess.RoleAsync(db, user.Id, docId, includeDeleted: true, ct);
                if (access is null)
                {
                    connection.Docs.TryRemove(docId, out _);
                    await docsHub.Groups.RemoveFromGroupAsync(connection.ConnectionId, DocsHub.Group(docId), ct);
                    await docsHub.Clients.Client(connection.ConnectionId).SendAsync("closed", docId, "You no longer have access to this doc.", ct);
                    await docsHub.Clients.Group(DocsHub.Group(docId)).SendAsync("peerLeave", docId, connection.Peer.Id, open.ClientId, ct);
                    continue;
                }

                var canEdit = access.Role.Grants(Permission.Comment);
                if (canEdit != open.CanEdit)
                {
                    open.CanEdit = canEdit;
                    await docsHub.Clients.Client(connection.ConnectionId).SendAsync("access", docId, canEdit, ct);
                }
            }
        }
    }

    private async Task RevalidatePresenceAsync(CancellationToken ct)
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

    /// <summary>A feature was turned off: close its live connections now (they can't reconnect while it's off).</summary>
    private void CloseTurnedOff(IReadOnlyDictionary<Feature, bool> changed)
    {
        if (changed.TryGetValue(Feature.LiveCursors, out var cursors) && !cursors)
        {
            foreach (var connection in registry.All())
            {
                connection.Context.Abort();
            }
        }

        if (changed.TryGetValue(Feature.Docs, out var docsOn) && !docsOn)
        {
            foreach (var connection in docs.All())
            {
                connection.Context.Abort();
            }
        }
    }

    private void CloseOutsideNetwork(IpAllowList list)
    {
        if (network.RestrictionDisabled)
        {
            return;
        }

        foreach (var (address, context) in registry.All().Select(c => (c.Address, c.Context)).Concat(docs.All().Select(c => (c.Address, c.Context))))
        {
            if (!(address is { } ip && IPAddress.IsLoopback(ip)) && !list.Allows(address))
            {
                context.Abort();
            }
        }
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Checking presence connections failed")]
    private static partial void LogRevalidationFailed(ILogger logger, Exception exception);
}
