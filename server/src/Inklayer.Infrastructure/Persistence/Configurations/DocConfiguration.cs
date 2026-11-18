using Inklayer.Domain.Annotations;
using Inklayer.Domain.Docs;
using Inklayer.Domain.Organizations;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class DocConfiguration : IEntityTypeConfiguration<Doc>
{
    public void Configure(EntityTypeBuilder<Doc> builder)
    {
        builder.HasKey(d => d.Id);
        builder.Property(d => d.Folder).HasMaxLength(Doc.MaxFolderLength);
        builder.Property(d => d.Title).HasMaxLength(Doc.MaxTitleLength);
        builder.Property(d => d.PathKey).HasMaxLength(Doc.MaxFolderLength + Doc.MaxTitleLength + 1);
        builder.Property(d => d.TitleKey).HasMaxLength(Doc.MaxTitleLength);
        builder.Property(d => d.Content).HasMaxLength(Doc.MaxContentLength);
        builder.Property(d => d.Version).IsConcurrencyToken();

        // One doc per path among those that aren't deleted; deleted docs keep their history.
        builder.HasIndex(d => new { d.OrganizationId, d.PathKey }).IsUnique().HasFilter("\"DeletedAt\" IS NULL");
        builder.HasIndex(d => new { d.OrganizationId, d.TitleKey });
        builder.HasOne<Organization>().WithMany().HasForeignKey(d => d.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class DocFolderConfiguration : IEntityTypeConfiguration<DocFolder>
{
    public void Configure(EntityTypeBuilder<DocFolder> builder)
    {
        builder.HasKey(f => f.Id);
        builder.Property(f => f.Path).HasMaxLength(Doc.MaxFolderLength);
        builder.Property(f => f.PathKey).HasMaxLength(Doc.MaxFolderLength);
        builder.HasIndex(f => new { f.OrganizationId, f.PathKey }).IsUnique();
        builder.HasOne<Organization>().WithMany().HasForeignKey(f => f.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class DocUpdateConfiguration : IEntityTypeConfiguration<DocUpdate>
{
    public void Configure(EntityTypeBuilder<DocUpdate> builder)
    {
        builder.HasKey(u => new { u.DocId, u.Seq });
        builder.HasOne<Doc>().WithMany().HasForeignKey(u => u.DocId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class DocRevisionConfiguration : IEntityTypeConfiguration<DocRevision>
{
    public void Configure(EntityTypeBuilder<DocRevision> builder)
    {
        builder.HasKey(r => r.Id);
        builder.Property(r => r.Action).HasMaxLength(16);
        builder.Property(r => r.Folder).HasMaxLength(Doc.MaxFolderLength);
        builder.Property(r => r.Title).HasMaxLength(Doc.MaxTitleLength);
        builder.HasIndex(r => new { r.DocId, r.Version });
        builder.HasIndex(r => new { r.OrganizationId, r.OccurredAt });
        builder.HasOne<Doc>().WithMany().HasForeignKey(r => r.DocId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class DocLinkConfiguration : IEntityTypeConfiguration<DocLink>
{
    public void Configure(EntityTypeBuilder<DocLink> builder)
    {
        builder.HasKey(l => l.Id);
        builder.Property(l => l.TargetKey).HasMaxLength(Doc.MaxFolderLength + Doc.MaxTitleLength + 1);
        builder.Property(l => l.Text).HasMaxLength(Doc.MaxFolderLength + Doc.MaxTitleLength + 1);
        builder.HasIndex(l => l.SourceDocId);
        builder.HasIndex(l => l.SourceAnnotationId);
        builder.HasIndex(l => l.TargetDocId);
        builder.HasIndex(l => l.TargetAnnotationId);
        builder.HasIndex(l => new { l.OrganizationId, l.TargetKey });
        builder.HasOne<Doc>().WithMany().HasForeignKey(l => l.SourceDocId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Annotation>().WithMany().HasForeignKey(l => l.SourceAnnotationId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Doc>().WithMany().HasForeignKey(l => l.TargetDocId).OnDelete(DeleteBehavior.SetNull);
    }
}

internal sealed class DocTagConfiguration : IEntityTypeConfiguration<DocTag>
{
    public void Configure(EntityTypeBuilder<DocTag> builder)
    {
        builder.HasKey(t => new { t.DocId, t.Tag });
        builder.Property(t => t.Tag).HasMaxLength(100);
        builder.HasIndex(t => new { t.OrganizationId, t.Tag });
        builder.HasOne<Doc>().WithMany().HasForeignKey(t => t.DocId).OnDelete(DeleteBehavior.Cascade);
    }
}
