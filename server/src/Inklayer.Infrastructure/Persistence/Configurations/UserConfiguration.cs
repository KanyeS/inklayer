using Inklayer.Domain.Users;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class UserConfiguration : IEntityTypeConfiguration<User>
{
    public void Configure(EntityTypeBuilder<User> builder)
    {
        builder.HasKey(u => u.Id);
        builder.Property(u => u.GoogleSubject).HasMaxLength(255);
        builder.Property(u => u.Email).HasMaxLength(320);
        builder.Property(u => u.DisplayName).HasMaxLength(200);
        builder.Property(u => u.AvatarUrl).HasMaxLength(2048);
        builder.Property(u => u.SecurityStamp).HasMaxLength(64);
        builder.HasIndex(u => u.GoogleSubject).IsUnique();
        builder.HasIndex(u => u.Email).IsUnique();
    }
}
