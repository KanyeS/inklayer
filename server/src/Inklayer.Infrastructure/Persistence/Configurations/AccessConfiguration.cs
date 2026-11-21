using Inklayer.Domain.Authorization;
using Inklayer.Domain.Organizations;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class TeamConfiguration : IEntityTypeConfiguration<Team>
{
    public void Configure(EntityTypeBuilder<Team> builder)
    {
        builder.HasKey(t => t.Id);
        builder.Property(t => t.Name).HasMaxLength(Team.MaxNameLength);
        builder.Property(t => t.Source).HasConversion<string>().HasMaxLength(16);
        builder.Property(t => t.ExternalId).HasMaxLength(200);
        builder.HasIndex(t => t.OrganizationId);
        builder.HasOne<Organization>().WithMany().HasForeignKey(t => t.OrganizationId).OnDelete(DeleteBehavior.Cascade);
        builder.HasMany(t => t.Members).WithOne().HasForeignKey(m => m.TeamId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class TeamMemberConfiguration : IEntityTypeConfiguration<TeamMember>
{
    public void Configure(EntityTypeBuilder<TeamMember> builder)
    {
        builder.HasKey(m => new { m.TeamId, m.UserId });
        builder.HasIndex(m => m.UserId);
        builder.HasOne(m => m.User).WithMany().HasForeignKey(m => m.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class AccessGrantConfiguration : IEntityTypeConfiguration<AccessGrant>
{
    public void Configure(EntityTypeBuilder<AccessGrant> builder)
    {
        builder.HasKey(g => new { g.ResourceType, g.ResourceId, g.PrincipalType, g.PrincipalId });
        builder.Property(g => g.ResourceType).HasConversion<string>().HasMaxLength(16);
        builder.Property(g => g.PrincipalType).HasConversion<string>().HasMaxLength(16);

        // "What can this person or team reach?" (an organisation's grants to a caller and their teams).
        builder.HasIndex(g => new { g.OrganizationId, g.PrincipalType, g.PrincipalId });
        builder.HasOne<Organization>().WithMany().HasForeignKey(g => g.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class AccessRequestConfiguration : IEntityTypeConfiguration<AccessRequest>
{
    public void Configure(EntityTypeBuilder<AccessRequest> builder)
    {
        builder.HasKey(r => r.Id);
        builder.Property(r => r.ResourceType).HasConversion<string>().HasMaxLength(16);
        builder.Property(r => r.Status).HasConversion<string>().HasMaxLength(16);
        builder.Property(r => r.Message).HasMaxLength(AccessRequest.MaxMessageLength);

        // One pending request per person and item.
        builder.HasIndex(r => new { r.ResourceType, r.ResourceId, r.UserId }).IsUnique().HasFilter("\"Status\" = 'Pending'");
        builder.HasIndex(r => new { r.OrganizationId, r.Status });
        builder.HasOne<Organization>().WithMany().HasForeignKey(r => r.OrganizationId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne(r => r.User).WithMany().HasForeignKey(r => r.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}
