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
        builder.Property(d => d.Icon).HasMaxLength(Doc.MaxIconLength);
        builder.Property(d => d.Color).HasMaxLength(7);
        builder.Property(d => d.Kind).HasMaxLength(16);
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

internal sealed class DocOrgShareConfiguration : IEntityTypeConfiguration<DocOrgShare>
{
    public void Configure(EntityTypeBuilder<DocOrgShare> builder)
    {
        builder.HasKey(s => new { s.DocId, s.OrganizationId });
        builder.HasIndex(s => s.OrganizationId);
        builder.HasOne<Doc>().WithMany().HasForeignKey(s => s.DocId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Organization>().WithMany().HasForeignKey(s => s.OrganizationId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class DocTagStyleConfiguration : IEntityTypeConfiguration<DocTagStyle>
{
    public void Configure(EntityTypeBuilder<DocTagStyle> builder)
    {
        builder.HasKey(l => new { l.OrganizationId, l.Tag });
        builder.Property(l => l.Tag).HasMaxLength(DocTagStyle.MaxTagLength);
        builder.Property(l => l.Icon).HasMaxLength(Doc.MaxIconLength);
        builder.Property(l => l.Color).HasMaxLength(7);
        builder.HasOne<Organization>().WithMany().HasForeignKey(l => l.OrganizationId).OnDelete(DeleteBehavior.Cascade);
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

internal sealed class KanbanBoardConfiguration : IEntityTypeConfiguration<KanbanBoard>
{
    public void Configure(EntityTypeBuilder<KanbanBoard> builder)
    {
        builder.HasKey(k => k.DocId);
        builder.Property(k => k.KeyPrefix).HasMaxLength(KanbanBoard.MaxKeyPrefixLength);
        builder.Property(k => k.SyncDirection).HasMaxLength(16);
        builder.Property(k => k.SyncError).HasMaxLength(1000);
        builder.Property(k => k.SyncVersion).IsConcurrencyToken();
        builder.HasIndex(k => new { k.OrganizationId, k.KeyPrefix }).IsUnique();
        builder.HasIndex(k => k.TrackerConnectionId);
        builder.HasOne<Doc>().WithOne().HasForeignKey<KanbanBoard>(k => k.DocId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Inklayer.Domain.Issues.IssueTrackerConnection>().WithMany().HasForeignKey(k => k.TrackerConnectionId).OnDelete(DeleteBehavior.SetNull);
    }
}

internal sealed class KanbanTaskConfiguration : IEntityTypeConfiguration<KanbanTask>
{
    public void Configure(EntityTypeBuilder<KanbanTask> builder)
    {
        builder.HasKey(t => new { t.DocId, t.TaskId });
        builder.Property(t => t.TaskId).HasMaxLength(64);
        builder.Property(t => t.Key).HasMaxLength(32);
        builder.Property(t => t.Title).HasMaxLength(KanbanTask.MaxTitleLength);
        builder.Property(t => t.ColumnId).HasMaxLength(64);
        builder.Property(t => t.ColumnName).HasMaxLength(200);
        builder.Property(t => t.Category).HasMaxLength(16);
        builder.Property(t => t.Type).HasMaxLength(16);
        builder.Property(t => t.Priority).HasMaxLength(16);
        builder.Property(t => t.ParentTaskId).HasMaxLength(64);
        builder.Property(t => t.ExternalId).HasMaxLength(200);
        builder.Property(t => t.ExternalKey).HasMaxLength(200);
        builder.Property(t => t.ExternalUrl).HasMaxLength(2000);
        builder.HasIndex(t => new { t.OrganizationId, t.Key });
        builder.HasIndex(t => new { t.OrganizationId, t.Due });
        builder.HasIndex(t => t.LinkedDocId);
        builder.HasOne<Doc>().WithMany().HasForeignKey(t => t.DocId).OnDelete(DeleteBehavior.Cascade);
        builder.HasMany(t => t.Assignees).WithOne().HasForeignKey(a => new { a.DocId, a.TaskId }).OnDelete(DeleteBehavior.Cascade);
        builder.HasMany(t => t.Tags).WithOne().HasForeignKey(a => new { a.DocId, a.TaskId }).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class KanbanTaskAssigneeConfiguration : IEntityTypeConfiguration<KanbanTaskAssignee>
{
    public void Configure(EntityTypeBuilder<KanbanTaskAssignee> builder)
    {
        builder.HasKey(a => new { a.DocId, a.TaskId, a.UserId });
        builder.Property(a => a.TaskId).HasMaxLength(64);
        builder.HasIndex(a => a.UserId);
    }
}

internal sealed class KanbanTaskTagConfiguration : IEntityTypeConfiguration<KanbanTaskTag>
{
    public void Configure(EntityTypeBuilder<KanbanTaskTag> builder)
    {
        builder.HasKey(a => new { a.DocId, a.TaskId, a.Tag });
        builder.Property(a => a.TaskId).HasMaxLength(64);
        builder.Property(a => a.Tag).HasMaxLength(DocTagStyle.MaxTagLength);
        builder.HasIndex(a => a.Tag);
    }
}
