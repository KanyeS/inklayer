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

        connectionString = ResolveDatabasePath(connectionString, contentRootPath);

        services.AddDbContextPool<InklayerDbContext>(options => options
            .UseSqlite(connectionString)
            .AddInterceptors(SqlitePragmaInterceptor.Instance));

        services.AddOptions<DatabaseOptions>().Bind(configuration.GetSection(DatabaseOptions.SectionName));
        services.AddHostedService<MigrationHostedService>();

        return services;
    }

    private static string ResolveDatabasePath(string connectionString, string contentRootPath)
    {
        var builder = new SqliteConnectionStringBuilder(connectionString);
        if (string.IsNullOrEmpty(builder.DataSource) || builder.DataSource == ":memory:" || builder.Mode == SqliteOpenMode.Memory)
        {
            return connectionString;
        }

        builder.DataSource = Path.GetFullPath(builder.DataSource, contentRootPath);
        Directory.CreateDirectory(Path.GetDirectoryName(builder.DataSource)!);
        return builder.ToString();
    }
}
