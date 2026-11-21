using Inklayer.Infrastructure.Persistence;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Inklayer.Tests.Infrastructure;

/// <summary>
/// Upgrading to grant-based access (<c>ProductAccess</c>) must not change anyone's access: each member keeps the role they had in
/// each product (their project override, else their organisation role), and Admins and Owners need no grants.
/// </summary>
public sealed class ProductAccessMigrationTests : IDisposable
{
    private const string Before = "20261121120708_PageDetailsMore";
    private const string After = "20261121191435_ProductAccess";

    private readonly string _path = Path.Combine(Path.GetTempPath(), $"inklayer-migration-{Guid.NewGuid():N}.db");

    [Fact]
    public async Task Existing_members_keep_their_role_in_every_product()
    {
        await using var db = new InklayerDbContext(new DbContextOptionsBuilder<InklayerDbContext>()
            .UseSqlite($"Data Source={_path};Pooling=False").UseOpenIddict().Options);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync(Before);

        var org = Guid.NewGuid();
        var otherOrg = Guid.NewGuid();
        var design = Guid.NewGuid();
        var marketing = Guid.NewGuid();
        var elsewhere = Guid.NewGuid();
        var viewer = Guid.NewGuid();
        var commenter = Guid.NewGuid();
        var admin = Guid.NewGuid();

        var connection = (SqliteConnection)db.Database.GetDbConnection();
        await connection.OpenAsync();
        foreach (var user in new[] { viewer, commenter, admin })
        {
            await InsertAsync(connection, "Users", new() { ["Id"] = user, ["Email"] = $"{user:N}@example.com" });
        }

        await InsertAsync(connection, "Organizations", new() { ["Id"] = org, ["DefaultRole"] = "Viewer" });
        await InsertAsync(connection, "Organizations", new() { ["Id"] = otherOrg, ["DefaultRole"] = "Viewer" });
        await InsertAsync(connection, "Projects", new() { ["Id"] = design, ["OrganizationId"] = org });
        await InsertAsync(connection, "Projects", new() { ["Id"] = marketing, ["OrganizationId"] = org });
        await InsertAsync(connection, "Projects", new() { ["Id"] = elsewhere, ["OrganizationId"] = otherOrg });
        await InsertAsync(connection, "OrganizationMembers", new() { ["OrganizationId"] = org, ["UserId"] = viewer, ["Role"] = "Viewer" });
        await InsertAsync(connection, "OrganizationMembers", new() { ["OrganizationId"] = org, ["UserId"] = commenter, ["Role"] = "Commenter" });
        await InsertAsync(connection, "OrganizationMembers", new() { ["OrganizationId"] = org, ["UserId"] = admin, ["Role"] = "Admin" });
        await InsertAsync(connection, "ProjectMembers", new() { ["ProjectId"] = design, ["UserId"] = viewer, ["Role"] = "Editor" });
        await InsertAsync(connection, "ProjectMembers", new() { ["ProjectId"] = marketing, ["UserId"] = commenter, ["Role"] = "Viewer" });

        await migrator.MigrateAsync(After);

        var grants = await db.AccessGrants.AsNoTracking().ToListAsync();
        var roles = grants.ToDictionary(g => (g.PrincipalId, g.ResourceId), g => g.Role.ToString());
        Assert.Equal(4, grants.Count);
        Assert.Equal("Editor", roles[(viewer, design)]);
        Assert.Equal("Viewer", roles[(viewer, marketing)]);
        Assert.Equal("Commenter", roles[(commenter, design)]);
        Assert.Equal("Viewer", roles[(commenter, marketing)]);
        Assert.All(grants, g => Assert.Equal(org, g.OrganizationId));
    }

    /// <summary>Inserts a row, filling required columns that aren't given with a placeholder, so the test survives later columns.</summary>
    private static async Task InsertAsync(SqliteConnection connection, string table, Dictionary<string, object> values)
    {
        await using (var info = connection.CreateCommand())
        {
            info.CommandText = $"PRAGMA table_info(\"{table}\")";
            await using var reader = await info.ExecuteReaderAsync();
            while (await reader.ReadAsync())
            {
                var (name, type, notNull, hasDefault) = (reader.GetString(1), reader.GetString(2), reader.GetBoolean(3), !reader.IsDBNull(4));
                if (notNull && !hasDefault && !values.ContainsKey(name))
                {
                    values[name] = type == "INTEGER" ? 0 : name.EndsWith("At", StringComparison.Ordinal) ? "2026-01-01 00:00:00" : name;
                }
            }
        }

        await using var insert = connection.CreateCommand();
        var names = values.Keys.ToList();
        insert.CommandText = $"INSERT INTO \"{table}\" ({string.Join(", ", names.Select(n => $"\"{n}\""))}) VALUES ({string.Join(", ", names.Select((_, i) => $"$p{i}"))})";
        for (var i = 0; i < names.Count; i++)
        {
            insert.Parameters.AddWithValue($"$p{i}", values[names[i]] is Guid g ? g.ToString().ToUpperInvariant() : values[names[i]]);
        }

        await insert.ExecuteNonQueryAsync();
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        File.Delete(_path);
    }
}
