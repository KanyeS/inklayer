using System.Net;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Presence;

/// <summary>What other people see of a connection. <see cref="Id"/> is a random id per connection, not the SignalR connection id.</summary>
/// <param name="Name">The name they chose to be shown as, or their real name.</param>
/// <param name="FullName">Their real name, from their sign-in provider (shown on hover).</param>
public sealed record PresencePeer(string Id, Guid UserId, string Name, string Color, string? FullName = null);

/// <summary>One open presence connection (one browser). Mutable state is guarded by the registry's lock.</summary>
internal sealed class PresenceConnection(string connectionId, HubCallerContext context, PresencePeer peer, string securityStamp, IPAddress? address, TokenBucket bucket)
{
    public string ConnectionId { get; } = connectionId;

    public HubCallerContext Context { get; } = context;

    public PresencePeer Peer { get; } = peer;

    public string SecurityStamp { get; } = securityStamp;

    public IPAddress? Address { get; } = address;

    public TokenBucket Bucket { get; } = bucket;

    /// <summary>Organisations in which the user can view at least one project.</summary>
    public IReadOnlySet<Guid> Organizations { get; set; } = new HashSet<Guid>();

    /// <summary>Page hash → the rooms (one per shared organisation) the connection is in for that page.</summary>
    public Dictionary<string, string[]> Pages { get; } = new(StringComparer.Ordinal);
}

/// <summary>
/// Who is live on which page, in memory. A room is one organisation + one page hash, so two people see each other only if
/// they share an organisation. Someone in several shared organisations is still one peer: messages go to the distinct
/// connections across the sender's rooms for that page, never once per room.
/// </summary>
internal sealed class PresenceRegistry(IHubContext<PresenceHub> hub, IOptions<PresenceOptions> options)
{
    private readonly Lock _lock = new();
    private readonly Dictionary<string, PresenceConnection> _connections = new(StringComparer.Ordinal);
    private readonly Dictionary<string, HashSet<string>> _rooms = new(StringComparer.Ordinal);

    public int ConnectionCount
    {
        get
        {
            lock (_lock)
            {
                return _connections.Count;
            }
        }
    }

    /// <summary>Adds the connection unless the user already has the maximum number open.</summary>
    public bool TryAdd(PresenceConnection connection)
    {
        lock (_lock)
        {
            if (_connections.Values.Count(c => c.Peer.UserId == connection.Peer.UserId) >= options.Value.MaxConnectionsPerUser)
            {
                return false;
            }

            _connections[connection.ConnectionId] = connection;
            return true;
        }
    }

    public PresenceConnection? Get(string connectionId)
    {
        lock (_lock)
        {
            return _connections.GetValueOrDefault(connectionId);
        }
    }

    public List<PresenceConnection> All()
    {
        lock (_lock)
        {
            return [.. _connections.Values];
        }
    }

    public static string RoomKey(Guid organizationId, string page) => $"{organizationId:N}:{page}";

    /// <summary>Joins the page in every organisation the user can see. Returns the people already there.</summary>
    public async Task<IReadOnlyList<PresencePeer>> JoinAsync(PresenceConnection connection, string page)
    {
        string[] rooms;
        lock (_lock)
        {
            if (!connection.Pages.ContainsKey(page) && connection.Pages.Count >= options.Value.MaxPagesPerConnection)
            {
                throw new HubException($"You can be live on at most {options.Value.MaxPagesPerConnection} pages at once.");
            }

            rooms = [.. connection.Organizations.Select(o => RoomKey(o, page))];
        }

        return await MoveAsync(connection, page, rooms, notifySelf: false);
    }

    public Task LeaveAsync(PresenceConnection connection, string page) => MoveAsync(connection, page, [], notifySelf: false);

    /// <summary>Leaves every page and forgets the connection.</summary>
    public async Task RemoveAsync(string connectionId)
    {
        PresenceConnection? connection;
        string[] pages;
        lock (_lock)
        {
            if (!_connections.Remove(connectionId, out connection))
            {
                return;
            }

            pages = [.. connection.Pages.Keys];
        }

        foreach (var page in pages)
        {
            await MoveAsync(connection, page, [], notifySelf: false);
        }
    }

    /// <summary>Applies a change in the user's organisations: rooms they lost are left, new ones joined, and both sides told.</summary>
    public async Task SetOrganizationsAsync(PresenceConnection connection, IReadOnlySet<Guid> organizations)
    {
        string[] pages;
        lock (_lock)
        {
            if (connection.Organizations.SetEquals(organizations))
            {
                return;
            }

            connection.Organizations = organizations;
            pages = [.. connection.Pages.Keys];
        }

        foreach (var page in pages)
        {
            await MoveAsync(connection, page, [.. organizations.Select(o => RoomKey(o, page))], notifySelf: true);
        }
    }

    /// <summary>Sends a cursor, selection or idle message to everyone who can see the sender on that page.</summary>
    public Task RelayAsync(PresenceConnection connection, string page, string method, object? payload)
    {
        List<string> recipients;
        lock (_lock)
        {
            recipients = [.. Recipients(connection, page).Select(c => c.ConnectionId)];
        }

        return recipients.Count == 0 ? Task.CompletedTask : hub.Clients.Clients(recipients).SendAsync(method, page, connection.Peer.Id, payload);
    }

    private async Task<IReadOnlyList<PresencePeer>> MoveAsync(PresenceConnection connection, string page, string[] rooms, bool notifySelf)
    {
        List<PresenceConnection> added, removed, after;
        lock (_lock)
        {
            var before = Recipients(connection, page);
            if (connection.Pages.Remove(page, out var oldRooms))
            {
                foreach (var room in oldRooms)
                {
                    if (_rooms.TryGetValue(room, out var members) && members.Remove(connection.ConnectionId) && members.Count == 0)
                    {
                        _rooms.Remove(room);
                    }
                }
            }

            // A connection that has already gone away must not be put back.
            if (rooms.Length > 0 && _connections.ContainsKey(connection.ConnectionId))
            {
                connection.Pages[page] = rooms;
                foreach (var room in rooms)
                {
                    if (!_rooms.TryGetValue(room, out var members))
                    {
                        _rooms[room] = members = new HashSet<string>(StringComparer.Ordinal);
                    }

                    members.Add(connection.ConnectionId);
                }
            }

            after = Recipients(connection, page);
            added = [.. after.Except(before)];
            removed = [.. before.Except(after)];
        }

        if (added.Count > 0)
        {
            await hub.Clients.Clients([.. added.Select(c => c.ConnectionId)]).SendAsync("peerJoin", page, connection.Peer);
        }

        if (removed.Count > 0)
        {
            await hub.Clients.Clients([.. removed.Select(c => c.ConnectionId)]).SendAsync("peerLeave", page, connection.Peer.Id);
        }

        if (notifySelf)
        {
            var self = hub.Clients.Client(connection.ConnectionId);
            foreach (var peer in added)
            {
                await self.SendAsync("peerJoin", page, peer.Peer);
            }

            foreach (var peer in removed)
            {
                await self.SendAsync("peerLeave", page, peer.Peer.Id);
            }
        }

        return [.. after.Select(c => c.Peer)];
    }

    /// <summary>The other connections sharing at least one of this connection's rooms for the page. Call under the lock.</summary>
    private List<PresenceConnection> Recipients(PresenceConnection connection, string page)
    {
        if (!connection.Pages.TryGetValue(page, out var rooms))
        {
            return [];
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (var room in rooms)
        {
            if (_rooms.TryGetValue(room, out var members))
            {
                ids.UnionWith(members);
            }
        }

        ids.Remove(connection.ConnectionId);
        return [.. ids.Select(id => _connections.GetValueOrDefault(id)).OfType<PresenceConnection>()];
    }
}

/// <summary>A simple token bucket: <c>capacity</c> messages in a burst, refilled at <c>capacity</c> per second.</summary>
internal sealed class TokenBucket(int capacity, TimeProvider clock)
{
    private readonly Lock _lock = new();
    private double _tokens = capacity;
    private long _last = clock.GetTimestamp();

    /// <summary>Messages refused since the last one that was allowed.</summary>
    public int Strikes { get; private set; }

    public bool TryTake()
    {
        lock (_lock)
        {
            var now = clock.GetTimestamp();
            _tokens = Math.Min(capacity, _tokens + (clock.GetElapsedTime(_last, now).TotalSeconds * capacity));
            _last = now;
            if (_tokens >= 1)
            {
                _tokens -= 1;
                Strikes = 0;
                return true;
            }

            Strikes++;
            return false;
        }
    }
}
