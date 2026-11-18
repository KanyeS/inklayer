namespace Inklayer.Infrastructure.Persistence;

public sealed class DatabaseOptions
{
    public const string SectionName = "Database";

    /// <summary>Apply pending EF Core migrations when the server starts. EF Core takes a database lock, so this is safe with several replicas.</summary>
    public bool MigrateOnStartup { get; set; } = true;
}
