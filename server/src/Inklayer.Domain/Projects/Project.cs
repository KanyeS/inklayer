using Inklayer.Domain.Authorization;

namespace Inklayer.Domain.Projects;

public sealed class Project
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    public required string Name { get; set; }

    public bool IsArchived { get; set; }

    public DateTime CreatedAt { get; init; }

    public List<ProjectMember> Members { get; init; } = [];
}

/// <summary>A per-project role override for an organisation member.</summary>
public sealed class ProjectMember
{
    public required Guid ProjectId { get; init; }

    public required Guid UserId { get; init; }

    public required Role Role { get; set; }
}
