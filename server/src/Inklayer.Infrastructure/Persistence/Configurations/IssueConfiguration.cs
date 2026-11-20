using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Inklayer.Domain.Projects;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class IssueTrackerConnectionConfiguration : IEntityTypeConfiguration<IssueTrackerConnection>
{
    public void Configure(EntityTypeBuilder<IssueTrackerConnection> builder)
    {
        builder.HasKey(c => c.Id);
        builder.Property(c => c.Kind).HasMaxLength(16);
        builder.Property(c => c.Name).HasMaxLength(100);
        builder.Property(c => c.Settings).HasMaxLength(2000);
        builder.Property(c => c.LastError).HasMaxLength(500);
        builder.HasIndex(c => c.ProjectId);
        builder.HasOne<Project>().WithMany().HasForeignKey(c => c.ProjectId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class AnnotationIssueConfiguration : IEntityTypeConfiguration<AnnotationIssue>
{
    public void Configure(EntityTypeBuilder<AnnotationIssue> builder)
    {
        builder.HasKey(i => i.Id);
        builder.Property(i => i.ExternalId).HasMaxLength(100);
        builder.Property(i => i.Key).HasMaxLength(50);
        builder.Property(i => i.Url).HasMaxLength(500);
        builder.Property(i => i.State).HasMaxLength(16);
        builder.HasIndex(i => i.AnnotationId);
        builder.HasIndex(i => i.LastSyncedAt);
        builder.HasIndex(i => new { i.ConnectionId, i.ExternalId });
        builder.HasOne<Annotation>().WithMany().HasForeignKey(i => i.AnnotationId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<IssueTrackerConnection>().WithMany().HasForeignKey(i => i.ConnectionId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class IssueCommentConfiguration : IEntityTypeConfiguration<IssueComment>
{
    public void Configure(EntityTypeBuilder<IssueComment> builder)
    {
        builder.HasKey(c => c.Id);
        builder.Property(c => c.IssueExternalId).HasMaxLength(100);
        builder.Property(c => c.ExternalId).HasMaxLength(100);
        builder.Property(c => c.AuthorName).HasMaxLength(200);
        builder.Property(c => c.AuthorUrl).HasMaxLength(500);
        builder.Property(c => c.Body).HasMaxLength(20_000);
        builder.HasIndex(c => new { c.ConnectionId, c.IssueExternalId, c.ExternalId }).IsUnique();
        builder.HasOne<IssueTrackerConnection>().WithMany().HasForeignKey(c => c.ConnectionId).OnDelete(DeleteBehavior.Cascade);
    }
}
