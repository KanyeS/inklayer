using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;

namespace Inklayer.Tests.Infrastructure;

/// <summary>
/// Boots the real API against a throwaway SQLite file in a temp directory. One instance is shared per test group.
/// </summary>
public sealed class InklayerApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly string _dataDirectory = Path.Combine(Path.GetTempPath(), "inklayer-tests", Guid.NewGuid().ToString("N"));

    public string DatabasePath => Path.Combine(_dataDirectory, "inklayer.db");

    public Task InitializeAsync() => Task.CompletedTask;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Database", $"Data Source={DatabasePath}");
    }

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dataDirectory))
        {
            Directory.Delete(_dataDirectory, recursive: true);
        }
    }
}

[CollectionDefinition(Name)]
public sealed class ApiTestGroup : ICollectionFixture<InklayerApiFactory>
{
    public const string Name = "api";
}
