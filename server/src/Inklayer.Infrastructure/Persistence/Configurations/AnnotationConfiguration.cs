using Inklayer.Domain.Annotations;
using Inklayer.Domain.Projects;
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
        builder.HasIndex(a => new { a.ProjectId, a.PageUrl, a.CreatedAt });
        builder.HasOne<Project>().WithMany().HasForeignKey(a => a.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class AnnotationReplyConfiguration : IEntityTypeConfiguration<AnnotationReply>
{
    public void Configure(EntityTypeBuilder<AnnotationReply> builder)
    {
        builder.HasKey(r => r.Id);
        builder.Property(r => r.Body).HasMaxLength(AnnotationReply.MaxBodyLength);
        builder.Property(r => r.Version).IsConcurrencyToken();
        builder.HasIndex(r => new { r.AnnotationId, r.CreatedAt });
        builder.HasIndex(r => r.CreatedAt);
        builder.HasOne<Annotation>().WithMany().HasForeignKey(r => r.AnnotationId).OnDelete(DeleteBehavior.Cascade);
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
