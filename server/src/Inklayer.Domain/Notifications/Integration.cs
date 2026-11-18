namespace Inklayer.Domain.Notifications;

public static class IntegrationKinds
{
    /// <summary>Emails people their notifications, through the server's SMTP settings.</summary>
    public const string Email = "email";

    /// <summary>Posts events to a Slack channel through an incoming webhook.</summary>
    public const string Slack = "slack";

    /// <summary>Posts events as signed JSON to any address.</summary>
    public const string Webhook = "webhook";
}

public static class IntegrationEvents
{
    public const string CommentCreated = "comment.created";
    public const string Mention = "mention";
    public const string Reply = "reply";
    public const string Resolved = "comment.resolved";
    public const string IssueCreated = "issue.created";

    public static readonly string[] All = [CommentCreated, Mention, Reply, Resolved, IssueCreated];
}

/// <summary>Where an organisation's notifications go besides the in-app inbox. An organisation can have any number.</summary>
public sealed class Integration
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    public required string Kind { get; init; }

    public required string Name { get; set; }

    public bool Enabled { get; set; } = true;

    /// <summary>Space-separated <see cref="IntegrationEvents"/> to send (Slack and webhooks; email follows each person's notifications).</summary>
    public string Events { get; set; } = string.Join(' ', IntegrationEvents.All);

    /// <summary>Only events from this project, if set.</summary>
    public Guid? ProjectId { get; set; }

    /// <summary>The webhook address, encrypted (Slack and webhooks).</summary>
    public string? ProtectedUrl { get; set; }

    /// <summary>The signing secret, encrypted (webhooks).</summary>
    public string? ProtectedSecret { get; set; }

    public Guid CreatedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public DateTime? LastSuccessAt { get; set; }

    public DateTime? LastErrorAt { get; set; }

    public string? LastError { get; set; }
}

/// <summary>A message waiting to be sent (an email, a Slack post, a webhook call), retried with backoff until it goes or gives up.</summary>
public sealed class OutboundMessage
{
    public const int MaxAttempts = 8;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required string Kind { get; init; }

    public Guid? IntegrationId { get; init; }

    /// <summary>For email: the address.</summary>
    public string? To { get; init; }

    public string Subject { get; init; } = "";

    /// <summary>Email text, or the JSON body for Slack and webhooks.</summary>
    public required string Body { get; init; }

    public int Attempts { get; set; }

    public DateTime NextAttemptAt { get; set; }

    public DateTime? SentAt { get; set; }

    public string? LastError { get; set; }

    public DateTime CreatedAt { get; init; }
}
