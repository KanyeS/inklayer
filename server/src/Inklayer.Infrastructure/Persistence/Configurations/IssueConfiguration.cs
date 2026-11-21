using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Users;
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
        builder.Property(i => i.Title).HasMaxLength(300);
        builder.Property(i => i.State).HasMaxLength(16);
        builder.HasIndex(i => i.AnnotationId);
        builder.HasIndex(i => i.LastSyncedAt);
        builder.HasIndex(i => new { i.ConnectionId, i.ExternalId });
        builder.HasOne<Annotation>().WithMany().HasForeignKey(i => i.AnnotationId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<IssueTrackerConnection>().WithMany().HasForeignKey(i => i.ConnectionId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class PullRequestSummaryConfiguration : IEntityTypeConfiguration<PullRequestSummary>
{
    public void Configure(EntityTypeBuilder<PullRequestSummary> builder)
    {
        builder.HasKey(s => s.Id);
        builder.Property(s => s.PullRequestId).HasMaxLength(100);
        builder.Property(s => s.CommentExternalId).HasMaxLength(200);
        builder.Property(s => s.Origin).HasMaxLength(500);
        builder.Property(s => s.Body).HasMaxLength(60_000);
        builder.HasIndex(s => new { s.ConnectionId, s.PullRequestId }).IsUnique();
        builder.HasOne<IssueTrackerConnection>().WithMany().HasForeignKey(s => s.ConnectionId).OnDelete(DeleteBehavior.Cascade);
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

internal sealed class TrackerAccountConfiguration : IEntityTypeConfiguration<TrackerAccount>
{
    public void Configure(EntityTypeBuilder<TrackerAccount> builder)
    {
        builder.HasKey(a => a.Id);
        builder.Property(a => a.Kind).HasMaxLength(16);
        builder.Property(a => a.ExternalUserId).HasMaxLength(100);
        builder.Property(a => a.Login).HasMaxLength(200);
        builder.Property(a => a.ProtectedAccessToken).HasMaxLength(4000);
        builder.Property(a => a.ProtectedRefreshToken).HasMaxLength(4000);
        builder.Property(a => a.ProfileUrl).HasMaxLength(500);
        builder.Property(a => a.Data).HasMaxLength(8000);
        builder.HasIndex(a => new { a.UserId, a.Kind }).IsUnique();
        builder.HasOne<User>().WithMany().HasForeignKey(a => a.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}
