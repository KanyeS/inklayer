using System.Data.Common;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Inklayer.Infrastructure.Persistence;

/// <summary>What a change can affect, for answering "has anything changed?" cheaply.</summary>
[Flags]
public enum ChangeAreas
{
    None = 0,
    Comments = 1,
    Docs = 2,
    Notifications = 4,
    All = Comments | Docs | Notifications,
}

/// <summary>
/// Counts writes to the database, per area, so that a page polling for changes can be told "nothing changed" (304) without
/// running its queries. Counts only go up; a restart starts them again under a new <see cref="Boot"/>.
/// <para>
/// Every write is counted, by the tables it touches: unknown tables count for every area, so a forgotten table means an
/// answer that wasn't needed, never a stale one. Writes in a transaction are counted again when it commits, so a read that
/// ran while the transaction was open (and didn't see it) can't be stamped as up to date.
/// </para>
/// </summary>
public sealed partial class ChangeClock
{
    private readonly long[] _versions = new long[3];

    public Guid Boot { get; } = Guid.NewGuid();

    /// <summary>A number that changes whenever something in <paramref name="areas"/> may have.</summary>
    public long Version(ChangeAreas areas)
    {
        long sum = 0;
        for (var i = 0; i < _versions.Length; i++)
        {
            if (((int)areas & (1 << i)) != 0)
            {
                sum += Volatile.Read(ref _versions[i]);
            }
        }

        return sum;
    }

    public void Bump(ChangeAreas areas)
    {
        for (var i = 0; i < _versions.Length; i++)
        {
            if (((int)areas & (1 << i)) != 0)
            {
                Interlocked.Increment(ref _versions[i]);
            }
        }
    }

    /// <summary>Tables whose writes never change what the polled pages show.</summary>
    private static readonly HashSet<string> Quiet = new(StringComparer.Ordinal)
    {
        "DocUpdates", "OutboundMessages", "ErrorEvents", "AuditEvents", "DataProtectionKeys",
        "OpenIddictTokens", "OpenIddictAuthorizations", "OpenIddictApplications", "OpenIddictScopes", "__EFMigrationsHistory",
    };

    private static readonly Dictionary<string, ChangeAreas> Owned = new(StringComparer.Ordinal)
    {
        ["Annotations"] = ChangeAreas.Comments,
        ["AnnotationRevisions"] = ChangeAreas.Comments,
        ["AnnotationReplies"] = ChangeAreas.Comments,
        ["AnnotationContexts"] = ChangeAreas.Comments,
        ["AnnotationScreenshots"] = ChangeAreas.Comments,
        ["AnnotationMedia"] = ChangeAreas.Comments,
        ["AnnotationIssues"] = ChangeAreas.Comments,
        ["IssueComments"] = ChangeAreas.Comments,
        ["PullRequestSummaries"] = ChangeAreas.Comments,
        ["Docs"] = ChangeAreas.Docs | ChangeAreas.Comments, // a comment shows the docs that mention it (but see DocTextColumns)
        ["DocFolders"] = ChangeAreas.Docs,
        ["DocRevisions"] = ChangeAreas.Docs,
        ["DocLinks"] = ChangeAreas.Docs | ChangeAreas.Comments,
        ["DocTags"] = ChangeAreas.Docs,
        ["DocTagStyles"] = ChangeAreas.Docs,
        ["DocOrgShares"] = ChangeAreas.Docs,
        ["DocSearch"] = ChangeAreas.Docs,
        ["Notifications"] = ChangeAreas.Notifications,
    };

    /// <summary>
    /// Columns of a doc that change as people type. Comments show docs' titles and links, not their text, so an update that
    /// only sets these doesn't change comments; one that only sets LastSeq (saving live edits) changes nothing shown.
    /// </summary>
    private static readonly HashSet<string> DocTextColumns = new(StringComparer.Ordinal)
    {
        "Content", "State", "SnapshotSeq", "LastSeq", "UpdatedAt", "UpdatedByUserId", "Version",
    };

    [GeneratedRegex("""(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+"(\w+)"(?:\s+AS\s+"\w+")?(?:\s+SET\s+(.*?)(?=\s+WHERE\b|\s+RETURNING\b|;|$))?""", RegexOptions.IgnoreCase | RegexOptions.Singleline)]
    private static partial Regex Writes();

    [GeneratedRegex("\"(\\w+)\"\\s*=(?!=)")]
    private static partial Regex Assigned();

    /// <summary>The areas a command may change. None for reads.</summary>
    public static ChangeAreas AreasOf(string sql)
    {
        var areas = ChangeAreas.None;
        foreach (Match write in Writes().Matches(sql))
        {
            var table = write.Groups[1].Value;
            if (Quiet.Contains(table))
            {
                continue;
            }

            if (table == "Docs" && write.Groups[2].Success)
            {
                var columns = Assigned().Matches(write.Groups[2].Value).Select(m => m.Groups[1].Value).ToList();
                if (columns.Count > 0 && columns.All(c => c == "LastSeq"))
                {
                    continue;
                }

                if (columns.Count > 0 && columns.All(DocTextColumns.Contains))
                {
                    areas |= ChangeAreas.Docs;
                    continue;
                }
            }

            areas |= Owned.GetValueOrDefault(table, ChangeAreas.All);
        }

        return areas;
    }
}

/// <summary>Counts the database's writes on a <see cref="ChangeClock"/>.</summary>
internal sealed class ChangeClockInterceptor(ChangeClock clock) : DbCommandInterceptor, IDbTransactionInterceptor
{
    private sealed class Written
    {
        public ChangeAreas Areas;
    }

    private readonly ConditionalWeakTable<DbTransaction, Written> _open = [];

    private void Count(DbCommand command)
    {
        var areas = ChangeClock.AreasOf(command.CommandText);
        if (areas == ChangeAreas.None)
        {
            return;
        }

        clock.Bump(areas);
        if (command.Transaction is { } transaction)
        {
            var written = _open.GetOrCreateValue(transaction);
            written.Areas |= areas;
        }
    }

    private void Committed(DbTransaction transaction)
    {
        if (_open.TryGetValue(transaction, out var written))
        {
            _open.Remove(transaction);
            clock.Bump(written.Areas);
        }
    }

    public override int NonQueryExecuted(DbCommand command, CommandExecutedEventData eventData, int result)
    {
        Count(command);
        return result;
    }

    public override ValueTask<int> NonQueryExecutedAsync(DbCommand command, CommandExecutedEventData eventData, int result, CancellationToken cancellationToken = default)
    {
        Count(command);
        return ValueTask.FromResult(result);
    }

    public override DbDataReader ReaderExecuted(DbCommand command, CommandExecutedEventData eventData, DbDataReader result)
    {
        Count(command);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
    {
        Count(command);
        return ValueTask.FromResult(result);
    }

    public override object? ScalarExecuted(DbCommand command, CommandExecutedEventData eventData, object? result)
    {
        Count(command);
        return result;
    }

    public override ValueTask<object?> ScalarExecutedAsync(DbCommand command, CommandExecutedEventData eventData, object? result, CancellationToken cancellationToken = default)
    {
        Count(command);
        return ValueTask.FromResult(result);
    }

    public void TransactionCommitted(DbTransaction transaction, TransactionEndEventData eventData) => Committed(transaction);

    public Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        Committed(transaction);
        return Task.CompletedTask;
    }

    public void TransactionRolledBack(DbTransaction transaction, TransactionEndEventData eventData) => _open.Remove(transaction);

    public Task TransactionRolledBackAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        _open.Remove(transaction);
        return Task.CompletedTask;
    }
}
