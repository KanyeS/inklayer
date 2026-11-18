using Inklayer.Domain.Notifications;
using Inklayer.Domain.Organizations;
using Inklayer.Domain.Users;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class NotificationConfiguration : IEntityTypeConfiguration<Notification>
{
    public void Configure(EntityTypeBuilder<Notification> builder)
    {
        builder.HasKey(n => n.Id);
        builder.Property(n => n.Kind).HasMaxLength(32);
        builder.Property(n => n.Preview).HasMaxLength(300);
        builder.Property(n => n.Where).HasMaxLength(300);
        builder.HasIndex(n => new { n.UserId, n.CreatedAt });
        builder.HasOne<User>().WithMany().HasForeignKey(n => n.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class IntegrationConfiguration : IEntityTypeConfiguration<Integration>
{
    public void Configure(EntityTypeBuilder<Integration> builder)
    {
        builder.HasKey(i => i.Id);
        builder.Property(i => i.Kind).HasMaxLength(16);
        builder.Property(i => i.Name).HasMaxLength(100);
        builder.Property(i => i.Events).HasMaxLength(300);
        builder.Property(i => i.LastError).HasMaxLength(500);
        builder.HasIndex(i => i.OrganizationId);
        builder.HasOne<Organization>().WithMany().HasForeignKey(i => i.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class OutboundMessageConfiguration : IEntityTypeConfiguration<OutboundMessage>
{
    public void Configure(EntityTypeBuilder<OutboundMessage> builder)
    {
        builder.HasKey(m => m.Id);
        builder.Property(m => m.Kind).HasMaxLength(16);
        builder.Property(m => m.To).HasMaxLength(320);
        builder.Property(m => m.Subject).HasMaxLength(300);
        builder.Property(m => m.LastError).HasMaxLength(500);
        builder.HasIndex(m => new { m.SentAt, m.NextAttemptAt });
        builder.HasOne<Integration>().WithMany().HasForeignKey(m => m.IntegrationId).OnDelete(DeleteBehavior.Cascade);
    }
}
