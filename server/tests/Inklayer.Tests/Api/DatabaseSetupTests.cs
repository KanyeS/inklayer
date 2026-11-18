using Inklayer.Tests.Infrastructure;
using Microsoft.Data.Sqlite;

namespace Inklayer.Tests.Api;

[Collection(ApiTestGroup.Name)]
public sealed class DatabaseSetupTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task Startup_creates_the_database_in_wal_mode()
    {
        // Booting the host runs the migration service, which creates the file.
        using var client = factory.CreateClient();
        await client.GetAsync(new Uri("/health/live", UriKind.Relative));

        Assert.True(File.Exists(factory.DatabasePath));

        await using var connection = new SqliteConnection($"Data Source={factory.DatabasePath}");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA journal_mode;";
        var mode = (string?)await command.ExecuteScalarAsync();

        Assert.Equal("wal", mode);
    }
}
