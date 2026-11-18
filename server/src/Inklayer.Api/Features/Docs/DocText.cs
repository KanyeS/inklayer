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
internal sealed class DocText(InklayerDbContext db, DocIndexer indexer, IHubContext<DocsHub> hub, TimeProvider clock)
{
    /// <summary>The doc's current text, including live edits not yet in a snapshot. Null if the doc doesn't exist.</summary>
    public async Task<string?> ReadAsync(Guid docId, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        var doc = await db.Docs.AsNoTracking().Where(d => d.Id == docId && d.DeletedAt == null)
            .Select(d => new { d.State, d.SnapshotSeq }).SingleOrDefaultAsync(ct);
        if (doc is null)
        {
            return null;
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
    /// </summary>
    public async Task<string?> EditAsync(Guid docId, Guid userId, Func<string, IReadOnlyList<TextEdit>> plan, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);

        // Taking the next update number first takes SQLite's write lock, so no edit can arrive between loading and saving.
        if (await db.Docs.Where(d => d.Id == docId && d.DeletedAt == null).ExecuteUpdateAsync(s => s.SetProperty(d => d.LastSeq, d => d.LastSeq + 1), ct) == 0)
        {
            return null;
        }

        // Reload: the doc may already be tracked from earlier in this request (e.g. just created), with the old number.
        var doc = await db.Docs.SingleAsync(d => d.Id == docId, ct);
        await db.Entry(doc).ReloadAsync(ct);
        var seq = doc.LastSeq;
        var updates = await db.DocUpdates.AsNoTracking().Where(u => u.DocId == docId && u.Seq > doc.SnapshotSeq).OrderBy(u => u.Seq).Select(u => u.Bytes).ToListAsync(ct);

        using var ydoc = Load(doc.State, updates);
        var text = ydoc.Text("content");
        string before;
        byte[] stateVector;
        using (var read = ydoc.ReadTransaction())
        {
            before = text.String(read);
            stateVector = read.StateVectorV1();
        }

        var edits = plan(before);
        if (edits.Count == 0)
        {
            return before; // nothing to do; the transaction rolls back, so the number isn't used
        }

        // Apply from the end, so earlier offsets stay valid.
        using (var write = ydoc.WriteTransaction())
        {
            foreach (var edit in edits.OrderByDescending(e => e.Index))
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

        byte[] update, state;
        string after;
        using (var read = ydoc.ReadTransaction())
        {
            update = read.StateDiffV1(stateVector);
            state = read.StateDiffV1(null!);
            after = text.String(read);
        }

        if (after.Length > Inklayer.Domain.Docs.Doc.MaxContentLength || state.Length > DocsHub.MaxStateBytes)
        {
            throw new InvalidOperationException("That would make the doc too large. Split it into smaller docs.");
        }

        // Saved as a snapshot that includes this update, so the update itself needn't be stored.
        var now = clock.GetUtcNow().UtcDateTime;
        doc.State = state;
        doc.SnapshotSeq = seq;
        doc.Content = after;
        doc.UpdatedAt = now;
        doc.UpdatedByUserId = userId;
        await db.DocUpdates.Where(u => u.DocId == docId && u.Seq <= seq).ExecuteDeleteAsync(ct);
        await DocsHub.AddEditRevisionsAsync(db, doc, [userId], now, ct);
        await db.SaveChangesAsync(ct);
        await indexer.IndexDocAsync(doc, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        await hub.Clients.Group(DocsHub.Group(docId)).SendAsync("update", docId, seq, update, ct);
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
