namespace Inklayer.Domain.Docs;

/// <summary>
/// What a kanban (a doc of kind <see cref="DocKinds.Kanban"/>) keeps outside its Yjs document: the prefix of its task keys
/// (<c>WEB</c> in <c>WEB-12</c>), the next number to hand out, and its link to a Jira project. Its columns and tasks live in
/// the Yjs document, like a board's cards; <see cref="KanbanTask"/> is the server's read-only copy of them.
/// </summary>
public sealed class KanbanBoard
{
    public const int MaxKeyPrefixLength = 10;

    public required Guid DocId { get; init; }

    public required Guid OrganizationId { get; init; }

    /// <summary>2–10 capital letters or digits, starting with a letter; unique in the organisation.</summary>
    public required string KeyPrefix { get; set; }

    /// <summary>The number the next task gets. Handed out atomically, so two people adding tasks at once get different keys.</summary>
    public long NextNumber { get; set; } = 1;

    /// <summary>The project's tracker connection this kanban syncs with (a Jira connection), or null.</summary>
    public Guid? TrackerConnectionId { get; set; }

    /// <summary>JSON: the tracker's status id → the kanban's column id.</summary>
    public string? StatusMap { get; set; }

    /// <summary>Both ways, or only from the tracker (<see cref="KanbanSyncDirections"/>).</summary>
    public string SyncDirection { get; set; } = KanbanSyncDirections.Both;

    /// <summary>The tracker's issues changed since this were read by the last sync.</summary>
    public DateTime? SyncedAt { get; set; }

    /// <summary>Why the last sync failed, to show on the kanban; null when it worked.</summary>
    public string? SyncError { get; set; }

    /// <summary>Two syncs at once (the timer and someone's "Sync now"): this keeps them from pushing the same change twice.</summary>
    public int SyncVersion { get; set; }

    /// <summary>Who connected the tracker: the sync's changes to the kanban are made as them.</summary>
    public Guid? ConnectedByUserId { get; set; }

    public DateTime? ConnectedAt { get; set; }

    /// <summary>Also create tracker issues for tasks that were on the kanban before it was connected.</summary>
    public bool PushExisting { get; set; }

    public static bool IsValidPrefix(string? prefix) =>
        prefix is { Length: >= 2 and <= MaxKeyPrefixLength } && char.IsAsciiLetterUpper(prefix[0]) && prefix.All(c => char.IsAsciiLetterUpper(c) || char.IsAsciiDigit(c));

    /// <summary>A prefix from a title: its words' first letters (<c>Web Platform</c> → <c>WP</c>), or its first letters if it's one word.</summary>
    public static string PrefixFrom(string title)
    {
        var words = title.Split([' ', '-', '_', '/', '.'], StringSplitOptions.RemoveEmptyEntries)
            .Select(w => new string([.. w.Where(char.IsAsciiLetterOrDigit)]).ToUpperInvariant())
            .Where(w => w.Length > 0 && char.IsAsciiLetterUpper(w[0]))
            .ToList();
        var prefix = words.Count switch
        {
            0 => "TASK",
            1 => words[0][..Math.Min(4, words[0].Length)],
            _ => new string([.. words.Take(4).Select(w => w[0])]),
        };
        return prefix.Length >= 2 ? prefix : (prefix + "TASK")[..4];
    }
}

public static class KanbanSyncDirections
{
    public const string Both = "both";
    public const string FromTracker = "from-tracker";

    public static bool IsValid(string? direction) => direction is Both or FromTracker;
}

/// <summary>A column's kind, as Jira's status categories: work not started, in progress, or done.</summary>
public static class KanbanCategories
{
    public const string Todo = "todo";
    public const string Doing = "doing";
    public const string Done = "done";

    public static bool IsValid(string? category) => category is Todo or Doing or Done;
}

/// <summary>
/// One task on a kanban, as of the kanban's last snapshot: the server reads the Yjs document itself and updates these rows, so
/// "My tasks", due-date reminders, search by assignee and the tracker sync don't depend on what a browser says.
/// </summary>
public sealed class KanbanTask
{
    public const int MaxTitleLength = 500;

    public required Guid DocId { get; init; }

    /// <summary>The task's id in the Yjs document.</summary>
    public required string TaskId { get; init; }

    public required Guid OrganizationId { get; init; }

    /// <summary><c>WEB-12</c>.</summary>
    public string Key { get; set; } = "";

    public string Title { get; set; } = "";

    public string ColumnId { get; set; } = "";

    public string ColumnName { get; set; } = "";

    /// <summary><see cref="KanbanCategories"/>.</summary>
    public string Category { get; set; } = KanbanCategories.Todo;

    public string Type { get; set; } = "task";

    public string Priority { get; set; } = "medium";

    public DateOnly? Due { get; set; }

    public string? ParentTaskId { get; set; }

    /// <summary>The doc the task links to, or became.</summary>
    public Guid? LinkedDocId { get; set; }

    /// <summary>The tracker issue it's synced with: its id, key (<c>ABC-123</c>) and address.</summary>
    public string? ExternalId { get; set; }

    public string? ExternalKey { get; set; }

    public string? ExternalUrl { get; set; }

    /// <summary>JSON: the fields as they were when last synced with the tracker, to tell which side changed what.</summary>
    public string? SyncedFields { get; set; }

    public DateTime UpdatedAt { get; set; }

    /// <summary>The due date the assignees were last reminded of (on the day), so each is reminded once.</summary>
    public DateOnly? DueRemindedFor { get; set; }

    /// <summary>The due date the assignees were last told is past.</summary>
    public DateOnly? OverdueRemindedFor { get; set; }

    public List<KanbanTaskAssignee> Assignees { get; init; } = [];

    public List<KanbanTaskTag> Tags { get; init; } = [];
}

public sealed class KanbanTaskAssignee
{
    public required Guid DocId { get; init; }

    public required string TaskId { get; init; }

    public required Guid UserId { get; init; }
}

/// <summary>A tag on a task, lowercase and without the <c>#</c>, as doc tags are.</summary>
public sealed class KanbanTaskTag
{
    public required Guid DocId { get; init; }

    public required string TaskId { get; init; }

    public required string Tag { get; init; }
}
