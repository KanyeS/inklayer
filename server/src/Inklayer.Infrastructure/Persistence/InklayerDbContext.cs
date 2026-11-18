using Microsoft.EntityFrameworkCore;

namespace Inklayer.Infrastructure.Persistence;

/// <summary>
/// The EF Core unit of work for Inklayer. Entities are added per feature; configurations live
/// alongside in <c>Persistence/Configurations</c> and are discovered automatically.
/// </summary>
public sealed class InklayerDbContext(DbContextOptions<InklayerDbContext> options) : DbContext(options)
{
    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(InklayerDbContext).Assembly);
    }
}
