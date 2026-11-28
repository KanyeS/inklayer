using System.Collections.Concurrent;
using System.Net;
using Inklayer.Api.Features.Presence;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Docs;

public sealed record DocUpdateMessage(long Seq, byte[] Bytes);

/// <summary>Everything a client needs to start editing: the last snapshot, the updates since, and who else is here.</summary>
/// <param name="State">The Yjs state as of <paramref name="SnapshotSeq"/>, or null for a new doc.</param>
/// <param name="Content">The markdown as of the snapshot; used to start a doc that has text but no Yjs state yet.</param>
/// <param name="Me">How others see this connection.</param>
public sealed record DocOpenResponse(
    Guid DocId, byte[]? State, string Content, long SnapshotSeq, IReadOnlyList<DocUpdateMessage> Updates, bool CanEdit, PresencePeer Me, IReadOnlyList<PresencePeer> Peers,
    string Kind = DocKinds.Doc);

/// <summary>One doc open on a connection.</summary>
internal sealed class OpenDoc(Guid organizationId, bool canEdit, long clientId)
{
    public Guid OrganizationId { get; } = organizationId;

    public bool CanEdit { get; set; } = canEdit;

    /// <summary>The Yjs client id of the connection's copy of the doc, so its caret can be removed when it leaves.</summary>
    public long ClientId { get; } = clientId;
}

/// <summary>One open docs connection (one browser tab).</summary>
internal sealed class DocsConnection(string connectionId, HubCallerContext context, PresencePeer peer, string securityStamp, IPAddress? address)
{
    public string ConnectionId { get; } = connectionId;

    public HubCallerContext Context { get; } = context;

    public PresencePeer Peer { get; } = peer;

    public string SecurityStamp { get; } = securityStamp;

    public IPAddress? Address { get; } = address;

    public ConcurrentDictionary<Guid, OpenDoc> Docs { get; } = new();
}

/// <summary>Who has which doc open, in memory. The docs themselves are never held here.</summary>
internal sealed class DocsRegistry(IOptions<PresenceOptions> options)
{
    private readonly ConcurrentDictionary<string, DocsConnection> _connections = new(StringComparer.Ordinal);

    public bool TryAdd(DocsConnection connection)
    {
        // Each tab is a connection; allow a few more than for presence.
        if (_connections.Values.Count(c => c.Peer.UserId == connection.Peer.UserId) >= options.Value.MaxConnectionsPerUser * 2)
        {
            return false;
        }

        _connections[connection.ConnectionId] = connection;
        return true;
    }

    public int ConnectionCount => _connections.Count;

    public DocsConnection? Get(string connectionId) => _connections.GetValueOrDefault(connectionId);

    public DocsConnection? Remove(string connectionId) => _connections.TryRemove(connectionId, out var connection) ? connection : null;

    public List<DocsConnection> All() => [.. _connections.Values];

    /// <summary>The other connections with this doc open.</summary>
    public List<DocsConnection> PeersOf(Guid docId, string exceptConnectionId) =>
        [.. _connections.Values.Where(c => c.ConnectionId != exceptConnectionId && c.Docs.ContainsKey(docId))];
}

/// <summary>
/// Live co-editing of docs. The server never interprets the Yjs documents: it stores and relays bytes.
/// <list type="bullet">
/// <item><c>Open</c>: the last snapshot plus the updates since; joins the doc's group.</item>
/// <item><c>Update</c>: an edit (Commenters and above). Given the next number for the doc and sent to everyone else straight
/// away; saved with the next batch (see <see cref="DocEditBuffer"/>).</item>
/// <item><c>Awareness</c>: carets, selections and pointers. Only relayed.</item>
/// <item><c>Snapshot</c>: an editor's merged copy plus its markdown, replacing the updates it includes. It's accepted only if
/// it's at least as new as the stored one, so two editors snapshotting at once can't lose edits.</item>
/// </list>
/// Server → client: <c>update(docId, seq, bytes)</c>, <c>awareness(docId, bytes)</c>, <c>peerJoin(docId, peer)</c>,
/// <c>peerLeave(docId, peerId, clientId)</c>, <c>compact(docId)</c>, <c>access(docId, canEdit)</c>, <c>closed(docId, reason)</c>.
/// </summary>
[Authorize(AuthenticationSchemes = PresenceTicketHandler.SchemeName)]
internal sealed partial class DocsHub(
    DocsRegistry registry, InklayerDbContext db, DocIndexer indexer, DocEditBuffer edits, IOptions<PresenceOptions> options, TimeProvider clock,
    FeatureSwitches features, Notifications.NotificationService notifications) : Hub
{
    /// <summary>Ask an editor for a snapshot once this many updates are waiting, and again every <see cref="CompactEvery"/> after.</summary>
    public const int CompactAfter = 100;
    public const int CompactEvery = 50;
    public const int MaxUpdateBytes = 256 * 1024;
    public const int MaxStateBytes = 2 * 1024 * 1024;
    private static readonly TimeSpan EditRevisionEvery = TimeSpan.FromMinutes(5);

    public static string Group(Guid docId) => $"doc:{docId:N}";

    public override async Task OnConnectedAsync()
    {
        if (await LiveIdentity.LoadAsync(Context, db, Context.ConnectionAborted) is not { } user)
        {
            Context.Abort();
            return;
        }

        LiveIdentity.AttachBucket(Context, options.Value, clock);
        var connection = new DocsConnection(Context.ConnectionId, Context, LiveIdentity.PeerFor(user), user.SecurityStamp, Context.GetHttpContext()?.Connection.RemoteIpAddress);
        if (!registry.TryAdd(connection))
        {
            Context.Abort();
        }
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (registry.Remove(Context.ConnectionId) is { } connection)
        {
            foreach (var (docId, open) in connection.Docs)
            {
                await Clients.Group(Group(docId)).SendAsync("peerLeave", docId, connection.Peer.Id, open.ClientId);
            }
        }
    }

    /// <param name="clientId">The Yjs client id of this tab's copy of the doc.</param>
    public async Task<DocOpenResponse> Open(Guid docId, long clientId)
    {
        var me = Me();
        // Through its own organisation or one it's shared with: either way it's the same doc, so everyone edits one copy.
        var access = await Inklayer.Api.Access.DocAccess.RoleAsync(db, me.Peer.UserId, docId, includeDeleted: false, Context.ConnectionAborted);
        if (access is null)
        {
            throw new HubException("This doc doesn't exist or you can't see it.");
        }

        var kind = await db.Docs.AsNoTracking().Where(d => d.Id == docId).Select(d => d.Kind).SingleAsync(Context.ConnectionAborted);
        if (kind == DocKinds.Board && !await features.IsEnabledAsync(Feature.Boards, Context.ConnectionAborted))
        {
            throw new HubException("Boards are turned off on this server.");
        }

        // Join first, so no update made while this one loads is missed; seeing one twice does no harm.
        await Groups.AddToGroupAsync(Context.ConnectionId, Group(docId));
        var canEdit = access.Role.Grants(Permission.Comment);
        me.Docs[docId] = new OpenDoc(access.OrganizationId, canEdit, clientId);

        // Edits still waiting to be saved are written first, so they're among the updates read below.
        await edits.FlushAsync(Context.ConnectionAborted);

        // One read transaction, so the snapshot and the updates after it match.
        await using var tx = await db.Database.BeginTransactionAsync();
        var doc = await db.Docs.AsNoTracking().Where(d => d.Id == docId).Select(d => new { d.State, d.Content, d.SnapshotSeq }).SingleAsync();
        var updates = await db.DocUpdates.AsNoTracking().Where(u => u.DocId == docId && u.Seq > doc.SnapshotSeq).OrderBy(u => u.Seq)
            .Select(u => new DocUpdateMessage(u.Seq, u.Bytes)).ToListAsync();
        await tx.CommitAsync();

        await Clients.OthersInGroup(Group(docId)).SendAsync("peerJoin", docId, me.Peer);
        var peers = registry.PeersOf(docId, Context.ConnectionId).Select(c => c.Peer).ToList();
        return new DocOpenResponse(docId, doc.State, doc.Content, doc.SnapshotSeq, updates, canEdit, me.Peer, peers, kind);
    }

    public async Task Close(Guid docId)
    {
        var me = Me();
        if (me.Docs.TryRemove(docId, out var open))
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(docId));
            await Clients.Group(Group(docId)).SendAsync("peerLeave", docId, me.Peer.Id, open.ClientId);
        }
    }

    /// <summary>Numbers an edit, sends it to everyone else on the doc and queues it to be saved. Returns its number.</summary>
    public async Task<long> Update(Guid docId, byte[] update)
    {
        var me = Me();
        Editing(me, docId);
        if (update.Length is 0 or > MaxUpdateBytes)
        {
            throw new HubException("That edit is too large.");
        }

        var (seq, snapshotSeq) = await edits.AppendAsync(docId, me.Peer.UserId, update, Context.ConnectionAborted);
        await Clients.OthersInGroup(Group(docId)).SendAsync("update", docId, seq, update);
        var waiting = seq - snapshotSeq;
        if (waiting >= CompactAfter && (waiting - CompactAfter) % CompactEvery == 0)
        {
            await Clients.Caller.SendAsync("compact", docId);
        }

        return seq;
    }

    /// <summary>Relays carets, selections and pointers (Yjs awareness) to everyone else on the doc, unless live cursors are off.</summary>
    public async Task Awareness(Guid docId, byte[] update)
    {
        var me = Me();
        if (me.Docs.ContainsKey(docId) && await features.IsEnabledAsync(Feature.LiveCursors, Context.ConnectionAborted))
        {
            await Clients.OthersInGroup(Group(docId)).SendAsync("awareness", docId, update);
        }
    }

    /// <summary>
    /// Replaces the updates up to <paramref name="upToSeq"/> with the editor's merged state, and saves the markdown for search,
    /// links and history. Returns false if a newer snapshot is already stored.
    /// </summary>
    public async Task<bool> Snapshot(Guid docId, byte[] state, string markdown, long upToSeq)
    {
        var me = Me();
        Editing(me, docId);
        if (state.Length > MaxStateBytes || markdown.Length > Doc.MaxContentLength)
        {
            throw new HubException("This doc is too large to save. Split it into smaller docs.");
        }

        // The edits it includes may still be waiting to be saved.
        await edits.FlushAsync(Context.ConnectionAborted);
        var saved = await SaveSnapshotAsync(db, indexer, docId, state, markdown, upToSeq, me.Peer.UserId, clock.GetUtcNow().UtcDateTime, default);
        if (saved is null)
        {
            return false;
        }

        edits.SnapshotSaved(docId, upToSeq);
        if (!string.Equals(saved.Value.OldContent, markdown, StringComparison.Ordinal))
        {
            await notifications.DocEditedAsync(saved.Value.Doc, saved.Value.OldContent, saved.Value.LastEditor, Context.ConnectionAborted);
        }

        return true;
    }

    /// <summary>
    /// Saves a snapshot: replaces the stored updates up to <paramref name="upToSeq"/> with <paramref name="state"/>, and saves the
    /// markdown for search, links and history. Null if a newer snapshot is already stored or the updates don't exist (yet).
    /// Call <see cref="DocEditBuffer.FlushAsync"/> first.
    /// </summary>
    /// <param name="editedBy">Someone whose edit the state includes beyond <paramref name="upToSeq"/> (a server-side edit): recorded as the
    /// last editor, and in history.</param>
    internal static async Task<(Doc Doc, string OldContent, Guid LastEditor)?> SaveSnapshotAsync(
        InklayerDbContext db, DocIndexer indexer, Guid docId, byte[] state, string markdown, long upToSeq, Guid savedBy, DateTime now, CancellationToken ct,
        Guid? editedBy = null)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // Only if nothing newer was stored meanwhile, and only up to updates that exist.
        var accepted = await db.Docs.Where(d => d.Id == docId && d.DeletedAt == null && d.SnapshotSeq <= upToSeq && d.LastSeq >= upToSeq)
            .ExecuteUpdateAsync(s => s.SetProperty(d => d.State, state).SetProperty(d => d.SnapshotSeq, upToSeq), ct);
        if (accepted == 0)
        {
            return null;
        }

        var editors = await db.DocUpdates.Where(u => u.DocId == docId && u.Seq <= upToSeq).OrderBy(u => u.Seq).Select(u => u.UserId).ToListAsync(ct);
        if (editedBy is { } extra)
        {
            editors.Add(extra);
        }

        await db.DocUpdates.Where(u => u.DocId == docId && u.Seq <= upToSeq).ExecuteDeleteAsync(ct);

        var doc = await db.Docs.SingleAsync(d => d.Id == docId, ct);
        await db.Entry(doc).ReloadAsync(ct); // may be tracked from earlier in the request, from before the update above
        var oldContent = doc.Content;
        var lastEditor = editors.Count > 0 ? editors[^1] : savedBy;
        if (!string.Equals(doc.Content, markdown, StringComparison.Ordinal))
        {
            doc.Content = markdown;
            doc.UpdatedAt = now;
            doc.UpdatedByUserId = lastEditor;

            await AddEditRevisionsAsync(db, doc, editors.Count > 0 ? [.. editors.Distinct()] : [savedBy], now, ct);

            await db.SaveChangesAsync(ct);
            await indexer.IndexDocAsync(doc, ct);
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return (doc, oldContent, lastEditor);
    }

    /// <summary>History: an "edited" entry per person, at most every few minutes each. Call after the doc's content changed.</summary>
    internal static async Task AddEditRevisionsAsync(InklayerDbContext db, Doc doc, IReadOnlyList<Guid> editors, DateTime now, CancellationToken ct)
    {
        foreach (var editor in editors)
        {
            var last = await db.DocRevisions.Where(r => r.DocId == doc.Id && r.ActorUserId == editor && r.Action == DocActions.Edited)
                .MaxAsync(r => (DateTime?)r.OccurredAt, ct);
            if (last is null || now - last.Value >= EditRevisionEvery)
            {
                db.DocRevisions.Add(DocEndpoints.Revision(doc, DocActions.Edited, editor, now));
            }
        }
    }

    private DocsConnection Me() => registry.Get(Context.ConnectionId) ?? throw new HubException("This connection is closing.");

    private static OpenDoc Editing(DocsConnection me, Guid docId)
    {
        if (!me.Docs.TryGetValue(docId, out var open))
        {
            throw new HubException("Open the doc first.");
        }

        return open.CanEdit ? open : throw new HubException("Your role lets you read docs, not edit them.");
    }
}
