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

internal sealed class AnnotationContextConfiguration : IEntityTypeConfiguration<AnnotationContext>
{
    public void Configure(EntityTypeBuilder<AnnotationContext> builder)
    {
        builder.HasKey(c => c.AnnotationId);
        builder.Property(c => c.TimeZone).HasMaxLength(64);
        builder.Property(c => c.Scripts).HasMaxLength(2000);
        builder.Property(c => c.IpNetwork).HasMaxLength(200);
        builder.Property(c => c.IpCountry).HasMaxLength(100);
        builder.Property(c => c.IpNetworkKind).HasMaxLength(16);
        builder.Property(c => c.Browser).HasMaxLength(100);
        builder.Property(c => c.Os).HasMaxLength(100);
        builder.Property(c => c.UserAgent).HasMaxLength(512);
        builder.Property(c => c.Selector).HasMaxLength(2000);
        builder.Property(c => c.ElementHtml).HasMaxLength(AnnotationContext.MaxHtmlLength);
        builder.Property(c => c.Console).HasMaxLength(AnnotationContext.MaxLogLength);
        builder.Property(c => c.Network).HasMaxLength(AnnotationContext.MaxLogLength);
        builder.HasOne<Annotation>().WithOne().HasForeignKey<AnnotationContext>(c => c.AnnotationId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class AnnotationScreenshotConfiguration : IEntityTypeConfiguration<AnnotationScreenshot>
{
    public void Configure(EntityTypeBuilder<AnnotationScreenshot> builder)
    {
        builder.HasKey(s => s.AnnotationId);
        builder.Property(s => s.ContentType).HasMaxLength(32);
        builder.Property(s => s.PublicToken).HasMaxLength(64);
        builder.HasIndex(s => s.PublicToken).IsUnique();
        builder.HasOne<Annotation>().WithOne().HasForeignKey<AnnotationScreenshot>(s => s.AnnotationId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class AnnotationMediaConfiguration : IEntityTypeConfiguration<AnnotationMedia>
{
    public void Configure(EntityTypeBuilder<AnnotationMedia> builder)
    {
        builder.HasKey(m => m.Id);
        builder.Property(m => m.Kind).HasMaxLength(16);
        builder.Property(m => m.ContentType).HasMaxLength(64);
        builder.Property(m => m.StorageKey).HasMaxLength(300);
        builder.Property(m => m.PublicToken).HasMaxLength(64);
        builder.HasIndex(m => new { m.AnnotationId, m.Kind }).IsUnique();
        builder.HasIndex(m => m.PublicToken).IsUnique();
        builder.HasOne<Annotation>().WithMany().HasForeignKey(m => m.AnnotationId).OnDelete(DeleteBehavior.Cascade);
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
