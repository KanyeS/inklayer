using Inklayer.Domain.Users;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace Inklayer.Infrastructure.Persistence.Configurations;

internal sealed class UserConfiguration : IEntityTypeConfiguration<User>
{
    public void Configure(EntityTypeBuilder<User> builder)
    {
        builder.HasKey(u => u.Id);
        builder.Property(u => u.Email).HasMaxLength(320);
        builder.Property(u => u.DisplayName).HasMaxLength(200);
        builder.Property(u => u.AvatarUrl).HasMaxLength(2048);
        builder.Property(u => u.SecurityStamp).HasMaxLength(64);
        builder.HasIndex(u => u.Email).IsUnique();
        builder.HasMany(u => u.Logins).WithOne().HasForeignKey(l => l.UserId).OnDelete(DeleteBehavior.Cascade);
    }
}

internal sealed class UserLoginConfiguration : IEntityTypeConfiguration<UserLogin>
{
    public void Configure(EntityTypeBuilder<UserLogin> builder)
    {
        builder.HasKey(l => new { l.Provider, l.Subject });
        builder.Property(l => l.Provider).HasMaxLength(64);
        builder.Property(l => l.Subject).HasMaxLength(255);

        // One account per provider per user.
        builder.HasIndex(l => new { l.UserId, l.Provider }).IsUnique();
    }
}
