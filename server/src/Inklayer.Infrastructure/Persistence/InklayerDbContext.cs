using Inklayer.Domain.Annotations;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Domain.Issues;
using Inklayer.Domain.Notifications;
using Inklayer.Domain.Organizations;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Settings;
using Inklayer.Domain.Sharing;
using Inklayer.Domain.Users;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Inklayer.Infrastructure.Persistence;

/// <summary>
/// The EF Core unit of work for Inklayer. Entity configurations live in <c>Persistence/Configurations</c>
/// and are discovered automatically. OpenIddict's tables (applications, authorizations, scopes, tokens) are mapped here as well.
/// </summary>
public sealed class InklayerDbContext(DbContextOptions<InklayerDbContext> options) : DbContext(options)
{
    public DbSet<User> Users => Set<User>();

    public DbSet<UserLogin> UserLogins => Set<UserLogin>();

    public DbSet<Organization> Organizations => Set<Organization>();

    public DbSet<OrganizationDomain> OrganizationDomains => Set<OrganizationDomain>();

    public DbSet<OrganizationMember> OrganizationMembers => Set<OrganizationMember>();

    public DbSet<Invitation> Invitations => Set<Invitation>();

    public DbSet<Project> Projects => Set<Project>();

    public DbSet<ProjectMember> ProjectMembers => Set<ProjectMember>();

    public DbSet<AuditEvent> AuditEvents => Set<AuditEvent>();

    public DbSet<ErrorEvent> ErrorEvents => Set<ErrorEvent>();

    public DbSet<Annotation> Annotations => Set<Annotation>();

    public DbSet<AnnotationRevision> AnnotationRevisions => Set<AnnotationRevision>();

    public DbSet<AnnotationReply> AnnotationReplies => Set<AnnotationReply>();

    public DbSet<AnnotationContext> AnnotationContexts => Set<AnnotationContext>();

    public DbSet<AnnotationScreenshot> AnnotationScreenshots => Set<AnnotationScreenshot>();

    public DbSet<Notification> Notifications => Set<Notification>();

    public DbSet<Integration> Integrations => Set<Integration>();

    public DbSet<OutboundMessage> OutboundMessages => Set<OutboundMessage>();

    public DbSet<IssueTrackerConnection> IssueTrackerConnections => Set<IssueTrackerConnection>();

    public DbSet<AnnotationIssue> AnnotationIssues => Set<AnnotationIssue>();

    public DbSet<IssueComment> IssueComments => Set<IssueComment>();

    public DbSet<ShareLink> ShareLinks => Set<ShareLink>();

    public DbSet<InstanceSetting> InstanceSettings => Set<InstanceSetting>();

    public DbSet<Doc> Docs => Set<Doc>();

    public DbSet<DocFolder> DocFolders => Set<DocFolder>();

    public DbSet<DocUpdate> DocUpdates => Set<DocUpdate>();

    public DbSet<DocRevision> DocRevisions => Set<DocRevision>();

    public DbSet<DocLink> DocLinks => Set<DocLink>();

    public DbSet<DocTag> DocTags => Set<DocTag>();

    public DbSet<DocTagStyle> DocTagStyles => Set<DocTagStyle>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        ArgumentNullException.ThrowIfNull(modelBuilder);
        modelBuilder.ApplyConfigurationsFromAssembly(typeof(InklayerDbContext).Assembly);
    }

    protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    {
        ArgumentNullException.ThrowIfNull(configurationBuilder);

        // Store roles as readable strings ("Editor") rather than numbers.
        configurationBuilder.Properties<Role>().HaveConversion<string>().HaveMaxLength(16);

        // All timestamps are UTC. SQLite stores them as ISO-8601 text, which sorts correctly, and they are read back as DateTimeKind.Utc.
        configurationBuilder.Properties<DateTime>().HaveConversion<UtcDateTimeConverter>();
        configurationBuilder.Properties<DateTime?>().HaveConversion<NullableUtcDateTimeConverter>();
    }

    private sealed class UtcDateTimeConverter() : ValueConverter<DateTime, DateTime>(
        v => v.Kind == DateTimeKind.Utc ? v : v.ToUniversalTime(),
        v => DateTime.SpecifyKind(v, DateTimeKind.Utc));

    private sealed class NullableUtcDateTimeConverter() : ValueConverter<DateTime?, DateTime?>(
        v => v == null ? v : v.Value.Kind == DateTimeKind.Utc ? v : v.Value.ToUniversalTime(),
        v => v == null ? v : DateTime.SpecifyKind(v.Value, DateTimeKind.Utc));
}
