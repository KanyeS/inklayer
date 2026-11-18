using Inklayer.Domain.Annotations;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Snapshots;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class AnnotationConfiguration : IEntityTypeConfiguration<Annotation>
{
    public void Configure(EntityTypeBuilder<Annotation> builder)
    {
        builder.HasKey(a => a.Id);
        builder.Property(a => a.Kind).HasConversion<string>().HasMaxLength(16);
        builder.Property(a => a.Status).HasConversion<string>().HasMaxLength(16);
        builder.Property(a => a.Body).HasMaxLength(10_000);
        builder.Property(a => a.Color).HasMaxLength(7);
        builder.Property(a => a.Version).IsConcurrencyToken();
        builder.Property(a => a.PageUrl).HasMaxLength(LivePageUrl.MaxLength);
        builder.HasIndex(a => new { a.SnapshotId, a.CreatedAt });
        builder.HasIndex(a => new { a.ProjectId, a.PageUrl, a.CreatedAt });
        builder.HasOne<Snapshot>().WithMany().HasForeignKey(a => a.SnapshotId).OnDelete(DeleteBehavior.Cascade);
        builder.ToTable(t => t.HasCheckConstraint("CK_Annotations_SnapshotOrPage", "(SnapshotId IS NULL) <> (PageUrl IS NULL)"));
    }
}

internal sealed class AnnotationRevisionConfiguration : IEntityTypeConfiguration<AnnotationRevision>
{
    public void Configure(EntityTypeBuilder<AnnotationRevision> builder)
    {
        builder.HasKey(r => r.Id);
        builder.Property(r => r.Action).HasMaxLength(16);
        builder.HasIndex(r => new { r.AnnotationId, r.Version }).IsUnique();
        builder.HasOne<Annotation>().WithMany().HasForeignKey(r => r.AnnotationId).OnDelete(DeleteBehavior.Cascade);
    }
}
