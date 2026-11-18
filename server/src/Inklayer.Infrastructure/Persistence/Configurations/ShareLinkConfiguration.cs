using Inklayer.Domain.Docs;
using Inklayer.Domain.Organizations;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Sharing;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class ShareLinkConfiguration : IEntityTypeConfiguration<ShareLink>
{
    public void Configure(EntityTypeBuilder<ShareLink> builder)
    {
        builder.HasKey(s => s.Id);
        builder.Property(s => s.TokenHash).HasMaxLength(64);
        builder.Property(s => s.ProtectedToken).HasMaxLength(1000);
        builder.Property(s => s.Kind).HasMaxLength(16);
        builder.Property(s => s.PageUrl).HasMaxLength(ShareLink.MaxPageUrlLength);
        builder.HasIndex(s => s.TokenHash).IsUnique();
        builder.HasIndex(s => s.ProjectId);
        builder.HasIndex(s => s.DocId);
        builder.HasOne<Organization>().WithMany().HasForeignKey(s => s.OrganizationId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Project>().WithMany().HasForeignKey(s => s.ProjectId).OnDelete(DeleteBehavior.Cascade);
        builder.HasOne<Doc>().WithMany().HasForeignKey(s => s.DocId).OnDelete(DeleteBehavior.Cascade);
    }
}
