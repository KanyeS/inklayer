using Inklayer.Domain.Organizations;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Snapshots;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class SnapshotConfiguration : IEntityTypeConfiguration<Snapshot>
{
    public void Configure(EntityTypeBuilder<Snapshot> builder)
    {
        builder.HasKey(s => s.Id);
        builder.Property(s => s.Url).HasMaxLength(4096);
        builder.Property(s => s.Title).HasMaxLength(500);
        builder.Property(s => s.UserAgent).HasMaxLength(512);
        builder.Property(s => s.DocumentHash).HasMaxLength(64);
        builder.Property(s => s.ScreenshotHash).HasMaxLength(64);
        builder.Property(s => s.ScreenshotContentType).HasMaxLength(32);
        builder.HasIndex(s => new { s.ProjectId, s.CapturedAt });
        builder.HasIndex(s => s.OrganizationId);
        builder.HasOne<Project>().WithMany().HasForeignKey(s => s.ProjectId).OnDelete(DeleteBehavior.Cascade);
        builder.HasMany(s => s.Assets).WithOne().HasForeignKey(a => a.SnapshotId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class SnapshotAssetConfiguration : IEntityTypeConfiguration<SnapshotAsset>
{
    public void Configure(EntityTypeBuilder<SnapshotAsset> builder)
    {
        builder.HasKey(a => new { a.SnapshotId, a.Hash });
        builder.Property(a => a.Hash).HasMaxLength(64);
        builder.Property(a => a.ContentType).HasMaxLength(128);
        builder.HasIndex(a => a.Hash);
    }
}

internal sealed class OrganizationBlobConfiguration : IEntityTypeConfiguration<OrganizationBlob>
{
    public void Configure(EntityTypeBuilder<OrganizationBlob> builder)
    {
        builder.HasKey(b => new { b.OrganizationId, b.Hash });
        builder.Property(b => b.Hash).HasMaxLength(64);
        builder.HasIndex(b => b.Hash);
        builder.HasOne<Organization>().WithMany().HasForeignKey(b => b.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}
