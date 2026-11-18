using System.Text.Json;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Live;
using Inklayer.Domain.Users;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Presence;

/// <summary>
/// Live cursors and selections between people in the same organisation on the same page. Nothing is stored.
/// <para>Pages are identified by a hash the extension computes from the page's address, so the server never sees URLs.
/// Cursor and selection payloads are relayed as they are; their size is capped by the hub's maximum message size.</para>
/// <para>Server → client: <c>peerJoin(page, peer)</c>, <c>peerLeave(page, peerId)</c>, <c>cursor(page, peerId, position)</c>,
/// <c>select(page, peerId, anchor|null)</c>, <c>idle(page, peerId, null)</c>.</para>
/// </summary>
[Authorize(AuthenticationSchemes = PresenceTicketHandler.SchemeName)]
internal sealed class PresenceHub(PresenceRegistry registry, InklayerDbContext db, IOptions<PresenceOptions> options, TimeProvider clock) : Hub
{
    public override async Task OnConnectedAsync()
    {
        var principal = Context.User;
        var ct = Context.ConnectionAborted;
        if (!Guid.TryParse(principal?.FindFirst(InklayerClaims.Subject)?.Value, out var userId))
        {
            Context.Abort();
            return;
        }

        var stamp = principal!.FindFirst(PresenceTicketHandler.StampClaim)?.Value ?? "";
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null || user.IsDisabled || !string.Equals(user.SecurityStamp, stamp, StringComparison.Ordinal))
        {
            Context.Abort();
            return;
        }

        var peer = new PresencePeer(Guid.NewGuid().ToString("N"), user.Id, user.DisplayName, PresenceColors.For(user.Id));
        var connection = new PresenceConnection(Context.ConnectionId, Context, peer, stamp, Context.GetHttpContext()?.Connection.RemoteIpAddress,
            new TokenBucket(options.Value.MessagesPerSecond, clock))
        {
            Organizations = await OrganizationsAsync(user, db, ct),
        };
        if (!registry.TryAdd(connection))
        {
            Context.Abort();
        }
    }

    public override Task OnDisconnectedAsync(Exception? exception) => registry.RemoveAsync(Context.ConnectionId);

    /// <summary>Goes live on a page. Returns the people already on it, including this person's other tabs or browsers.</summary>
    public async Task<IReadOnlyList<PresencePeer>> Join(string page) => await registry.JoinAsync(Me(), ValidPage(page));

    public Task Leave(string page) => registry.LeaveAsync(Me(), ValidPage(page));

    /// <summary>Where the pointer is: an element path with fractions of its box, or document coordinates.</summary>
    public Task Cursor(string page, JsonElement position) => registry.RelayAsync(Me(), ValidPage(page), "cursor", position);

    /// <summary>The selected text or element as an anchor, or null when nothing is selected.</summary>
    public Task Select(string page, JsonElement? anchor) => registry.RelayAsync(Me(), ValidPage(page), "select", anchor);

    /// <summary>The tab was hidden or the pointer left the window.</summary>
    public Task Idle(string page) => registry.RelayAsync(Me(), ValidPage(page), "idle", null);

    /// <summary>Organisations in which the user can view at least one project.</summary>
    internal static async Task<IReadOnlySet<Guid>> OrganizationsAsync(User user, InklayerDbContext db, CancellationToken ct) =>
        (await LiveEndpoints.VisibleProjectsAsync(user, db, ct)).Select(p => p.Project.OrganizationId).ToHashSet();

    private PresenceConnection Me() =>
        registry.Get(Context.ConnectionId) ?? throw new HubException("This connection is closing.");

    /// <summary>A page is the lowercase hex SHA-256 of its key.</summary>
    private static string ValidPage(string? page) =>
        page is { Length: 64 } && page.All(char.IsAsciiHexDigitLower) ? page : throw new HubException("Unknown page.");
}

/// <summary>Each person's colour, the same on every page and for everyone looking.</summary>
internal static class PresenceColors
{
    private static readonly string[] Palette =
    [
        "#F24E1E", "#A259FF", "#1ABCFE", "#0ACF83", "#FF7262", "#9747FF",
        "#E8A100", "#E84393", "#00A3A3", "#FF8A00", "#4F7CFF", "#14AE5C",
    ];

    public static string For(Guid userId)
    {
        var hash = 17u;
        foreach (var b in userId.ToByteArray())
        {
            hash = unchecked((hash * 31) + b);
        }

        return Palette[hash % (uint)Palette.Length];
    }
}

/// <summary>Drops messages over the connection's rate; a flood closes the connection.</summary>
internal sealed class PresenceRateFilter(PresenceRegistry registry, IOptions<PresenceOptions> options) : IHubFilter
{
    public async ValueTask<object?> InvokeMethodAsync(HubInvocationContext invocationContext, Func<HubInvocationContext, ValueTask<object?>> next)
    {
        if (registry.Get(invocationContext.Context.ConnectionId) is { } connection && !connection.Bucket.TryTake())
        {
            // A whole second's allowance refused in a row is a flood, not a fast mouse.
            if (connection.Bucket.Strikes >= options.Value.MessagesPerSecond)
            {
                invocationContext.Context.Abort();
            }

            if (invocationContext.HubMethodName is nameof(PresenceHub.Join) or nameof(PresenceHub.Leave))
            {
                throw new HubException("Too many messages. Slow down.");
            }

            return null;
        }

        return await next(invocationContext);
    }
}
