using System.Collections.Concurrent;
using System.Security.Cryptography;
using Microsoft.AspNetCore.WebUtilities;

namespace Inklayer.Api.Features.Presence;

/// <summary><c>Inklayer:Presence</c>: limits for live cursors and selections.</summary>
public sealed class PresenceOptions
{
    public const string SectionName = "Inklayer:Presence";

    /// <summary>How long a connection ticket can be used for. It is single-use.</summary>
    public TimeSpan TicketLifetime { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>Open connections per user, across their browsers.</summary>
    public int MaxConnectionsPerUser { get; set; } = 5;

    /// <summary>
    /// Open live connections (presence and docs together) across everyone. Past this, new connections are refused with 503
    /// and the clients try again later; each one costs memory, and on a small server they are what fills it.
    /// 0 means no limit.
    /// </summary>
    public int MaxConnections { get; set; } = 300;

    /// <summary>Pages (tabs) one connection can be live on at once.</summary>
    public int MaxPagesPerConnection { get; set; } = 20;

    /// <summary>Sustained messages per second per connection; bursts up to this many are allowed.</summary>
    public int MessagesPerSecond { get; set; } = 40;

    /// <summary>How often open connections are checked against the user's account and organisations.</summary>
    public TimeSpan RevalidateEvery { get; set; } = TimeSpan.FromMinutes(5);
}

/// <summary>Who a ticket was issued to. The stamp is the user's security stamp when it was issued.</summary>
internal sealed record PresenceTicket(Guid UserId, string Name, string SecurityStamp, DateTimeOffset ExpiresAt);

/// <summary>
/// Single-use, short-lived tickets for opening the presence connection. Browsers can't send an Authorization header on a
/// WebSocket, so the extension trades its access token for a ticket (over a normal request) and puts the ticket in the URL:
/// the access token itself never appears in a URL or a log.
/// </summary>
internal sealed class PresenceTickets(TimeProvider clock)
{
    private readonly ConcurrentDictionary<string, PresenceTicket> _tickets = new(StringComparer.Ordinal);

    public string Issue(Guid userId, string name, string securityStamp, TimeSpan lifetime)
    {
        Sweep();
        var value = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        _tickets[value] = new PresenceTicket(userId, name, securityStamp, clock.GetUtcNow() + lifetime);
        return value;
    }

    public PresenceTicket? Consume(string? value) =>
        !string.IsNullOrEmpty(value) && _tickets.TryRemove(value, out var ticket) && ticket.ExpiresAt > clock.GetUtcNow() ? ticket : null;

    private void Sweep()
    {
        var now = clock.GetUtcNow();
        foreach (var (key, ticket) in _tickets)
        {
            if (ticket.ExpiresAt <= now)
            {
                _tickets.TryRemove(key, out _);
            }
        }
    }
}
