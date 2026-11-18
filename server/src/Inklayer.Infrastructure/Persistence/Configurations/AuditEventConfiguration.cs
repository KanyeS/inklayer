using Inklayer.Domain.Auditing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class AuditEventConfiguration : IEntityTypeConfiguration<AuditEvent>
{
    public void Configure(EntityTypeBuilder<AuditEvent> builder)
    {
        // No foreign keys: audit history must outlive the users and organisations it mentions.
        builder.HasKey(e => e.Id);
        builder.Property(e => e.Action).HasMaxLength(64);
        builder.Property(e => e.TargetType).HasMaxLength(64);
        builder.Property(e => e.TargetId).HasMaxLength(64);
        builder.Property(e => e.Data).HasMaxLength(4000);
        builder.Property(e => e.IpAddress).HasMaxLength(64);
        builder.HasIndex(e => new { e.OrganizationId, e.OccurredAt });
        builder.HasIndex(e => e.OccurredAt);
    }
}
