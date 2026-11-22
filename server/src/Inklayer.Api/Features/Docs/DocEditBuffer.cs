using System.Collections.Concurrent;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Docs;

/// <summary><c>Inklayer:Docs</c>: how live edits are saved.</summary>
public sealed class DocsOptions
{
    public const string SectionName = "Inklayer:Docs";

    /// <summary>
    /// How often edits are written to the database, all docs together in one transaction. They're numbered and sent to the
    /// other editors straight away; only saving waits. Typing sends an edit every 250 ms, so saving each on its own was a
    /// transaction every 250 ms per person typing.
    /// </summary>
    public TimeSpan SaveEditsEvery { get; set; } = TimeSpan.FromSeconds(1);
}

/// <summary>
/// Numbers live edits (1, 2, 3… per doc) as they arrive, so they can be sent to the other editors at once, and writes them
/// to the database in batches.
/// <para>
/// The numbers stay without gaps: <see cref="Doc.LastSeq"/> in the database only moves when the edits up to it are
/// written, in the same transaction, and this counts on from it. If the server stops without saving (a crash), the edits it
/// hadn't written are lost here, and their numbers are given out again after the restart. Every editor reconnects then,
/// reloads the doc and sends whatever the server is missing, so the edits come back from their browsers.
/// </para>
/// <para>
/// Anything that reads a doc's updates from the database, or relies on <see cref="Doc.LastSeq"/> there, calls
/// <see cref="FlushAsync"/> first. Only one server can number a doc's edits: running several would need a shared counter.
/// </para>
/// </summary>
internal sealed partial class DocEditBuffer(IServiceScopeFactory scopes, IOptions<DocsOptions> options, TimeProvider clock, ILogger<DocEditBuffer> logger)
    : BackgroundService
{
    private static readonly TimeSpan ForgetIdleAfter = TimeSpan.FromMinutes(10);

    private readonly ConcurrentDictionary<Guid, DocCounter> _docs = new();
    private readonly SemaphoreSlim _flushing = new(1, 1);
    private readonly SemaphoreSlim _loading = new(1, 1); // a doc's number is read once, after which it's kept here

    /// <summary>A doc's numbering. Fields are guarded by the instance's lock.</summary>
    private sealed class DocCounter
    {
        public readonly Lock Lock = new();
        public bool Loaded;
        public long LastSeq;
        public long SnapshotSeq;
        public List<DocUpdate> Pending = [];
        public long LastUsedTicks;
    }

    /// <summary>
    /// Numbers an edit and queues it to be saved. Returns its number and the doc's last snapshot number (to know when to
    /// ask for a new one). Throws <see cref="HubException"/> if the doc doesn't exist or was deleted.
    /// </summary>
    public async Task<(long Seq, long SnapshotSeq)> AppendAsync(Guid docId, Guid userId, byte[] bytes, CancellationToken ct)
    {
        while (true)
        {
            var counter = await LoadAsync(docId, ct) ?? throw new HubException("This doc was deleted.");
            lock (counter.Lock)
            {
                if (!counter.Loaded)
                {
                    continue; // forgotten (deleted, or idle) between loading and here: load it again
                }

                var seq = ++counter.LastSeq;
                counter.Pending.Add(new DocUpdate { DocId = docId, Seq = seq, Bytes = bytes, UserId = userId, At = clock.GetUtcNow().UtcDateTime });
                counter.LastUsedTicks = Environment.TickCount64;
                return (seq, counter.SnapshotSeq);
            }
        }
    }

    /// <summary>A snapshot up to <paramref name="upToSeq"/> was saved.</summary>
    public void SnapshotSaved(Guid docId, long upToSeq)
    {
        if (_docs.TryGetValue(docId, out var counter))
        {
            lock (counter.Lock)
            {
                counter.SnapshotSeq = Math.Max(counter.SnapshotSeq, upToSeq);
            }
        }
    }

    /// <summary>Writes every waiting edit to the database now.</summary>
    public async Task FlushAsync(CancellationToken ct)
    {
        await _flushing.WaitAsync(ct);
        try
        {
            await FlushLockedAsync(ct);
        }
        finally
        {
            _flushing.Release();
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(options.Value.SaveEditsEvery, clock);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await FlushAsync(stoppingToken);
                    ForgetIdle();
                }
                catch (Exception e) when (e is not OperationCanceledException)
                {
                    LogFlushFailed(logger, e); // the edits stay queued; the next tick tries again
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    /// <summary>Saves what's waiting before the server stops.</summary>
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);
        try
        {
            await FlushAsync(CancellationToken.None);
        }
        catch (Exception e)
        {
            LogFlushFailed(logger, e);
        }
    }

    private async Task<DocCounter?> LoadAsync(Guid docId, CancellationToken ct)
    {
        var counter = _docs.GetOrAdd(docId, _ => new DocCounter());
        lock (counter.Lock)
        {
            if (counter.Loaded)
            {
                return counter;
            }
        }

        await _loading.WaitAsync(ct);
        try
        {
            lock (counter.Lock)
            {
                if (counter.Loaded)
                {
                    return counter;
                }
            }

            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            var doc = await db.Docs.AsNoTracking().Where(d => d.Id == docId && d.DeletedAt == null)
                .Select(d => new { d.LastSeq, d.SnapshotSeq }).SingleOrDefaultAsync(ct);
            if (doc is null)
            {
                _docs.TryRemove(new KeyValuePair<Guid, DocCounter>(docId, counter));
                return null;
            }

            lock (counter.Lock)
            {
                counter.LastSeq = doc.LastSeq;
                counter.SnapshotSeq = doc.SnapshotSeq;
                counter.LastUsedTicks = Environment.TickCount64;
                counter.Loaded = true;
                if (!_docs.TryGetValue(docId, out var current) || current != counter)
                {
                    _docs[docId] = counter; // forgotten while loading; this one is current now
                }
            }

            return counter;
        }
        finally
        {
            _loading.Release();
        }
    }

    private async Task FlushLockedAsync(CancellationToken ct)
    {
        // Take what's waiting. Each doc's edits come out in number order, and every number up to its last is among them
        // or already saved.
        var batch = new List<(Guid DocId, DocCounter Counter, List<DocUpdate> Updates)>();
        foreach (var (docId, counter) in _docs)
        {
            lock (counter.Lock)
            {
                if (counter.Pending.Count > 0)
                {
                    batch.Add((docId, counter, counter.Pending));
                    counter.Pending = [];
                }
            }
        }

        if (batch.Count == 0)
        {
            return;
        }

        var deleted = new List<Guid>();
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            await using var tx = await db.Database.BeginTransactionAsync(ct);
            foreach (var (docId, _, updates) in batch)
            {
                var last = updates[^1].Seq;
                if (await db.Docs.Where(d => d.Id == docId && d.DeletedAt == null).ExecuteUpdateAsync(s => s.SetProperty(d => d.LastSeq, last), ct) == 0)
                {
                    deleted.Add(docId); // deleted meanwhile: its edits go with it
                    continue;
                }

                db.DocUpdates.AddRange(updates);
            }

            await db.SaveChangesAsync(ct);
            await tx.CommitAsync(ct);
        }
        catch
        {
            // Put them back in front of anything that arrived since, so the next try saves them in order.
            foreach (var (_, counter, updates) in batch)
            {
                lock (counter.Lock)
                {
                    counter.Pending.InsertRange(0, updates);
                }
            }

            throw;
        }

        foreach (var docId in deleted)
        {
            Forget(docId);
        }
    }

    private void ForgetIdle()
    {
        var now = Environment.TickCount64;
        foreach (var (docId, counter) in _docs)
        {
            // Checked and removed under the doc's lock, so an edit can't be queued in between and dropped.
            lock (counter.Lock)
            {
                if (counter.Loaded && counter.Pending.Count == 0 && now - counter.LastUsedTicks >= ForgetIdleAfter.TotalMilliseconds
                    && _docs.TryRemove(new KeyValuePair<Guid, DocCounter>(docId, counter)))
                {
                    counter.Loaded = false;
                }
            }
        }
    }

    /// <summary>The next edit to this doc loads its number from the database again (and finds out if it was deleted).</summary>
    private void Forget(Guid docId)
    {
        if (_docs.TryRemove(docId, out var counter))
        {
            lock (counter.Lock)
            {
                counter.Loaded = false;
                counter.Pending.Clear();
            }
        }
    }

    public override void Dispose()
    {
        _flushing.Dispose();
        _loading.Dispose();
        base.Dispose();
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Saving doc edits failed; they stay queued and are tried again")]
    private static partial void LogFlushFailed(ILogger logger, Exception exception);
}
