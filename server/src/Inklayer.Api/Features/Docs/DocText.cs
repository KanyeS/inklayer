using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;

using YDotNet.Document.Options;

namespace Inklayer.Api.Features.Docs;

/// <summary>A change to a doc's text: at <see cref="Index"/> (UTF-16 units, like JavaScript), remove <see cref="Delete"/> characters and insert <see cref="Insert"/>.</summary>
public sealed record TextEdit(int Index, int Delete, string Insert);

/// <summary>
/// Reads and edits a doc's text on the server, for the MCP tools. Docs are Yjs documents, so this uses YDotNet (Yjs's Rust
/// core, yrs) to merge the stored snapshot and updates, apply an edit as a proper Yjs change, and send it to everyone
/// editing in the browser, who merge it like any other edit.
/// </summary>
internal sealed class DocText(
    InklayerDbContext db, DocIndexer indexer, DocEditBuffer edits, IHubContext<DocsHub> hub, TimeProvider clock, Notifications.NotificationService notifications)
{
    /// <summary>The doc's current text, including live edits not yet in a snapshot. Null if the doc doesn't exist. For a board:
    /// its markdown summary (the docs on it as links, and its notes), as of its last snapshot.</summary>
    public async Task<string?> ReadAsync(Guid docId, CancellationToken ct)
    {
        await edits.FlushAsync(ct);
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var doc = await db.Docs.AsNoTracking().Where(d => d.Id == docId && d.DeletedAt == null)
            .Select(d => new { d.State, d.SnapshotSeq, d.Kind, d.Content }).SingleOrDefaultAsync(ct);
        if (doc is null)
        {
            return null;
        }

        if (doc.Kind == DocKinds.Board)
        {
            return doc.Content;
        }

        var updates = await db.DocUpdates.AsNoTracking().Where(u => u.DocId == docId && u.Seq > doc.SnapshotSeq).OrderBy(u => u.Seq).Select(u => u.Bytes).ToListAsync(ct);
        await tx.CommitAsync(ct);
        using var ydoc = Load(doc.State, updates);
        return TextOf(ydoc);
    }

    /// <summary>
    /// Applies the edits <paramref name="plan"/> returns for the current text, as <paramref name="userId"/>. The result is saved
    /// as a snapshot straight away (so search, links and history see it) and sent to open editors. Returns the new text, or
    /// null if the doc doesn't exist. <paramref name="plan"/> may throw to refuse (e.g. text to replace wasn't found).
    /// A board has no text to edit: it's left alone and its summary returned (see <see cref="BoardEditor"/> for boards).
    /// </summary>
    public Task<string?> EditAsync(Guid docId, Guid userId, Func<string, IReadOnlyList<TextEdit>> plan, CancellationToken ct) =>
        ChangeAsync(docId, userId, DocKinds.Doc, (ydoc, _) =>
        {
            var text = ydoc.Text("content");
            string before;
            using (var read = ydoc.ReadTransaction())
            {
                before = text.String(read);
            }

            var changes = plan(before);
            if (changes.Count == 0)
            {
                return Task.FromResult<(string, string?)>((before, null));
            }

            // Apply from the end, so earlier offsets stay valid.
            using (var write = ydoc.WriteTransaction())
            {
                foreach (var edit in changes.OrderByDescending(e => e.Index))
                {
                    if (edit.Delete > 0)
                    {
                        text.RemoveRange(write, (uint)edit.Index, (uint)edit.Delete);
                    }

                    if (edit.Insert.Length > 0)
                    {
                        text.Insert(write, (uint)edit.Index, edit.Insert);
                    }
                }

                write.Commit();
            }

            using var after = ydoc.ReadTransaction();
            return Task.FromResult<(string, string?)>((before, text.String(after)));
        }, ct);

    /// <summary>
    /// Changes a doc's Yjs document on the server, as <paramref name="userId"/>: <paramref name="change"/> makes the change and
    /// returns the markdown before and after it (after null: nothing changed). The change is numbered and sent to open editors
    /// like a browser's, and saved as a snapshot straight away. Returns the markdown after, or null if the doc doesn't exist.
    /// A doc of the other kind isn't changed: for a board asked to change as text, its summary is returned as it is.
    /// </summary>
    internal async Task<string?> ChangeAsync(
        Guid docId, Guid userId, string kind, Func<YDotNet.Document.Doc, string, Task<(string Before, string? After)>> change, CancellationToken ct)
    {
        // Everything numbered so far is in the database after this, up to the doc's LastSeq there. Browser edits that arrive
        // while this works are numbered after it, and Yjs merges them with this edit like any two people typing at once.
        await edits.FlushAsync(ct);
        long includedSeq;
        byte[]? storedState;
        string storedContent;
        List<byte[]> updates;
        await using (var tx = await db.Database.BeginTransactionAsync(ct))
        {
            var stored = await db.Docs.AsNoTracking().Where(d => d.Id == docId && d.DeletedAt == null)
                .Select(d => new { d.State, d.SnapshotSeq, d.LastSeq, d.Kind, d.Content }).SingleOrDefaultAsync(ct);
            if (stored is null)
            {
                return null;
            }

            if (stored.Kind != kind)
            {
                return stored.Kind == DocKinds.Board ? stored.Content : throw new InvalidOperationException("That's a doc, not a board.");
            }

            (includedSeq, storedState, storedContent) = (stored.LastSeq, stored.State, stored.Content);
            updates = await db.DocUpdates.AsNoTracking().Where(u => u.DocId == docId && u.Seq > stored.SnapshotSeq).OrderBy(u => u.Seq).Select(u => u.Bytes).ToListAsync(ct);
            await tx.CommitAsync(ct);
        }

        using var ydoc = Load(storedState, updates);
        byte[] stateVector;
        using (var read = ydoc.ReadTransaction())
        {
            stateVector = read.StateVectorV1();
        }

        var (before, changed) = await change(ydoc, storedContent);
        if (changed is not { } after)
        {
            return before;
        }

        byte[] update, state;
        using (var read = ydoc.ReadTransaction())
        {
            update = read.StateDiffV1(stateVector);
            state = read.StateDiffV1(null!);
        }

        if (after.Length > Inklayer.Domain.Docs.Doc.MaxContentLength || state.Length > DocsHub.MaxStateBytes)
        {
            throw new InvalidOperationException(kind == DocKinds.Board
                ? "That would make the board too large. Split it into smaller boards."
                : "That would make the doc too large. Split it into smaller docs.");
        }

        // Numbered and sent like a browser's edit, so open editors merge it.
        long seq;
        try
        {
            (seq, _) = await edits.AppendAsync(docId, userId, update, ct);
        }
        catch (HubException)
        {
            return null; // deleted meanwhile
        }

        await hub.Clients.Group(DocsHub.Group(docId)).SendAsync("update", docId, seq, update, ct);

        // And saved as a snapshot straight away, so search, links and history see it. The state is what this read (up to
        // includedSeq) plus this edit. If no one else's edit was numbered in between, the snapshot covers this edit's number
        // too; otherwise it stops at includedSeq, and this edit's update is kept as well (applying it twice does nothing).
        var upToSeq = includedSeq;
        if (seq == includedSeq + 1)
        {
            await edits.FlushAsync(ct);
            upToSeq = seq;
        }

        var saved = await DocsHub.SaveSnapshotAsync(db, indexer, docId, state, after, upToSeq, userId, clock.GetUtcNow().UtcDateTime, ct, editedBy: userId);
        if (saved is { } s)
        {
            edits.SnapshotSaved(docId, upToSeq);
            await notifications.DocEditedAsync(s.Doc, before, userId, ct);
        }

        // Not saved only if an editor saved a newer snapshot meanwhile; theirs then includes this edit, or their next will.
        return after;
    }

    /// <summary>A Yjs document from a snapshot and the updates after it. Offsets are UTF-16, as in the browser.</summary>
    internal static YDotNet.Document.Doc Load(byte[]? state, IEnumerable<byte[]> updates)
    {
        var ydoc = new YDotNet.Document.Doc(new DocOptions { Encoding = DocEncoding.Utf16 });
        ydoc.Text("content");
        using var write = ydoc.WriteTransaction();
        if (state is { Length: > 0 })
        {
            write.ApplyV1(state);
        }

        foreach (var update in updates)
        {
            write.ApplyV1(update);
        }

        write.Commit();
        return ydoc;
    }

    internal static string TextOf(YDotNet.Document.Doc ydoc)
    {
        var text = ydoc.Text("content");
        using var read = ydoc.ReadTransaction();
        return text.String(read);
    }
}
