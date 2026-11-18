using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Organizations;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Users;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Inklayer.Infrastructure.Persistence;

/// <summary>
/// The EF Core unit of work for Inklayer. Entity configurations live in <c>Persistence/Configurations</c>
/// and are discovered automatically. OpenIddict's tables (applications, authorizations, scopes, tokens) are mapped here as well.
/// </summary>
public sealed class InklayerDbContext(DbContextOptions<InklayerDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();

    public DbSet<Organization> Organizations => Set<Organization>();

    public DbSet<OrganizationDomain> OrganizationDomains => Set<OrganizationDomain>();

    public DbSet<OrganizationMember> OrganizationMembers => Set<OrganizationMember>();

    public DbSet<Invitation> Invitations => Set<Invitation>();

    public DbSet<Project> Projects => Set<Project>();

    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();

    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(InklayerDbContext).Assembly);
    }

    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        ArgumentNullException.ThrowIfNull(configurationBuilder);

        // Store roles as readable strings ("Editor") rather than numbers.
        configurationBuilder.Properties<Role>().HaveConversion<string>().HaveMaxLength(16);

        // All timestamps are UTC. SQLite stores them as ISO-8601 text, which sorts correctly, and they are read back as DateTimeKind.Utc.
        configurationBuilder.Properties<DateTime>().HaveConversion<UtcDateTimeConverter>();
        configurationBuilder.Properties<DateTime?>().HaveConversion<NullableUtcDateTimeConverter>();
    }

    private sealed class UtcDateTimeConverter() : ValueConverter<DateTime, DateTime>(
        v => v.Kind == DateTimeKind.Utc ? v : v.ToUniversalTime(),
        v => DateTime.SpecifyKind(v, DateTimeKind.Utc));

    private sealed class NullableUtcDateTimeConverter() : ValueConverter<DateTime?, DateTime?>(
        v => v == null ? v : v.Value.Kind == DateTimeKind.Utc ? v : v.Value.ToUniversalTime(),
        v => v == null ? v : DateTime.SpecifyKind(v.Value, DateTimeKind.Utc));
}
