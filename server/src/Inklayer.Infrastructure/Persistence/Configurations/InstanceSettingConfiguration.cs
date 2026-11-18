using Inklayer.Domain.Settings;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class InstanceSettingConfiguration : IEntityTypeConfiguration<InstanceSetting>
{
    public void Configure(EntityTypeBuilder<InstanceSetting> builder)
    {
        builder.ToTable("InstanceSettings");
        builder.HasKey(s => s.Key);
        builder.Property(s => s.Key).HasMaxLength(64);
        builder.Property(s => s.Value).HasMaxLength(16_000);
    }
}
