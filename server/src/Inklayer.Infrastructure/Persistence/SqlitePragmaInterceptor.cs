using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Inklayer.Infrastructure.Persistence;

/// <summary>
/// Sets SQLite options on every connection so it copes with many concurrent users:
/// <list type="bullet">
/// <item><c>journal_mode=WAL</c>: readers don't block the writer, and the writer doesn't block readers. The setting is stored in the database file.</item>
/// <item><c>busy_timeout</c>: a writer waits for the lock instead of failing straight away with SQLITE_BUSY.</item>
/// <item><c>synchronous=NORMAL</c>: safe with WAL, and much faster than FULL.</item>
/// <item><c>foreign_keys=ON</c>: enforce relationships.</item>
/// </list>
/// </summary>
internal sealed class SqlitePragmaInterceptor : DbConnectionInterceptor
{
    public static readonly SqlitePragmaInterceptor Instance = new();

    private const string Pragmas =
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        ArgumentNullException.ThrowIfNull(connection);
        using var command = connection.CreateCommand();
        command.CommandText = Pragmas;
        command.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(connection);
        var command = connection.CreateCommand();
        await using (command.ConfigureAwait(false))
        {
            command.CommandText = Pragmas;
            await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }
    }
}
