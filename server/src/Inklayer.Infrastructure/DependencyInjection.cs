using Inklayer.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Infrastructure;

public static class DependencyInjection
{
    public const string DatabaseConnectionName = "Database";

    /// <param name="contentRootPath">A relative SQLite <c>Data Source</c> is resolved against this path, not the process working directory.</param>
    public static IServiceCollection AddInklayerInfrastructure(this IServiceCollection services, IConfiguration configuration, string contentRootPath)
    {
        ArgumentNullException.ThrowIfNull(configuration);

        var connectionString = configuration.GetConnectionString(DatabaseConnectionName);
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException(
                $"Connection string 'ConnectionStrings:{DatabaseConnectionName}' is not configured (e.g. 'Data Source=/data/inklayer.db').");
        }

        connectionString = ResolveDatabasePath(connectionString, contentRootPath, out var databaseDirectory);

        var dataRoot = configuration["Inklayer:DataDirectory"] is { Length: > 0 } configuredRoot
            ? Path.GetFullPath(configuredRoot, contentRootPath)
            : databaseDirectory ?? Path.Combine(contentRootPath, ".data");
        var paths = new DataPaths(dataRoot);
        Directory.CreateDirectory(paths.Keys);
        services.AddSingleton(paths);
        Directory.CreateDirectory(paths.Blobs);
        services.AddSingleton<Storage.BlobStore>();

        services.AddDbContextPool<InklayerDbContext>(options => options
            .UseSqlite(connectionString)
            .AddInterceptors(SqlitePragmaInterceptor.Instance)
            .UseOpenIddict());

        services.AddOptions<DatabaseOptions>().Bind(configuration.GetSection(DatabaseOptions.SectionName));
        services.AddHostedService<MigrationHostedService>();

        return services;
    }

    private static string ResolveDatabasePath(string connectionString, string contentRootPath, out string? databaseDirectory)
    {
        databaseDirectory = null;
        var builder = new SqliteConnectionStringBuilder(connectionString);
        if (string.IsNullOrEmpty(builder.DataSource) || builder.DataSource == ":memory:" || builder.Mode == SqliteOpenMode.Memory)
        {
            return connectionString;
        }

        builder.DataSource = Path.GetFullPath(builder.DataSource, contentRootPath);
        databaseDirectory = Path.GetDirectoryName(builder.DataSource)!;
        Directory.CreateDirectory(databaseDirectory);
        return builder.ToString();
    }
}
