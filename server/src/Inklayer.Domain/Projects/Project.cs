namespace Inklayer.Domain.Projects;

public sealed class Project
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    public required string Name { get; set; }

    public bool IsArchived { get; set; }

    public DateTime CreatedAt { get; init; }
}

