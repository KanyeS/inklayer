namespace Inklayer.Domain.Docs;

/// <summary>
/// A markdown note in an organisation's knowledge base. Everyone in the organisation can read it; Commenters and above edit it.
/// <para>The text is co-edited live as a Yjs document. The server never interprets Yjs: it stores the merged
/// <see cref="State"/> and the plain <see cref="Content"/> that editors send in snapshots, plus the updates made since
/// (<see cref="DocUpdate"/>). <see cref="Content"/> is what search, links, tags and history use.</para>
/// </summary>
public sealed class Doc
{
    public const int MaxTitleLength = 200;
    public const int MaxFolderLength = 500;
    public const int MaxContentLength = 1_000_000;

    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    /// <summary>Folder path, e.g. <c>Research/Interviews</c>; empty for the top level.</summary>
    public string Folder { get; private set; } = "";

    public string Title { get; private set; } = "";

    /// <summary>Lowercase <c>folder/title</c>, unique per organisation among docs that aren't deleted.</summary>
    public string PathKey { get; private set; } = "";

    /// <summary>Lowercase title, for resolving <c>[[Title]]</c> links.</summary>
    public string TitleKey { get; private set; } = "";

    /// <summary>The markdown as of the last snapshot.</summary>
    public string Content { get; set; } = "";

    /// <summary>The Yjs document as of the last snapshot (an encoded state update); null for a new, empty doc.</summary>
    public byte[]? State { get; set; }

    /// <summary>The last <see cref="DocUpdate.Seq"/> included in <see cref="State"/>.</summary>
    public long SnapshotSeq { get; set; }

    public required Guid CreatedByUserId { get; init; }

    public DateTime CreatedAt { get; init; }

    public Guid UpdatedByUserId { get; set; }

    public DateTime UpdatedAt { get; set; }

    /// <summary>Goes up on every rename, move, delete or saved edit. Rename and move send it back to detect conflicts.</summary>
    public int Version { get; set; } = 1;

    public DateTime? DeletedAt { get; set; }

    /// <summary>When the last <see cref="DocRevision"/> for an edit was written, so editing adds at most one every few minutes.</summary>
    public DateTime? LastRevisionAt { get; set; }

    public void Place(string folder, string title)
    {
        Folder = folder;
        Title = title;
        PathKey = DocPaths.Key(folder, title);
        TitleKey = title.ToLowerInvariant();
    }
}

/// <summary>A folder, so empty folders can exist. Folders that contain docs exist whether or not they have a row.</summary>
public sealed class DocFolder
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    public required string Path { get; set; }

    public required string PathKey { get; set; }
}

/// <summary>A Yjs update made since the doc's last snapshot. Deleted once a snapshot includes it.</summary>
public sealed class DocUpdate
{
    /// <summary>Assigned by the database; increases with every update.</summary>
    public long Seq { get; init; }

    public required Guid DocId { get; init; }

    public required byte[] Bytes { get; init; }

    public required Guid UserId { get; init; }

    public DateTime At { get; init; }
}

public static class DocActions
{
    public const string Created = "created";
    public const string Edited = "edited";
    public const string Renamed = "renamed";
    public const string Moved = "moved";
    public const string Deleted = "deleted";
}

/// <summary>History: the doc's title, folder and text after a change, and who made it.</summary>
public sealed class DocRevision
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid DocId { get; init; }

    public required Guid OrganizationId { get; init; }

    public required int Version { get; init; }

    public required string Action { get; init; }

    public required Guid ActorUserId { get; init; }

    public DateTime OccurredAt { get; init; }

    public required string Folder { get; init; }

    public required string Title { get; init; }

    public required string Content { get; init; }
}

/// <summary>
/// A link found in a doc or a comment: to a doc (<c>[[Title]]</c>) or to a comment (<c>[[comment:id]]</c>). Rebuilt
/// whenever the source changes. Links to docs that don't exist yet keep <see cref="TargetKey"/> and are resolved when such a
/// doc is created. Backlinks, the graph and "mentioned in" all read this table.
/// </summary>
public sealed class DocLink
{
    public Guid Id { get; init; } = Guid.CreateVersion7();

    public required Guid OrganizationId { get; init; }

    public Guid? SourceDocId { get; init; }

    public Guid? SourceAnnotationId { get; init; }

    public Guid? TargetDocId { get; set; }

    public Guid? TargetAnnotationId { get; init; }

    /// <summary>For doc links: the lowercase target as written, <c>title</c> or <c>folder/title</c>.</summary>
    public string TargetKey { get; init; } = "";

    /// <summary>The target as written, for showing unresolved links.</summary>
    public string Text { get; init; } = "";
}

/// <summary>A <c>#tag</c> in a doc, lowercase.</summary>
public sealed class DocTag
{
    public required Guid DocId { get; init; }

    public required string Tag { get; init; }

    public required Guid OrganizationId { get; init; }
}

/// <summary>Rules for folder paths and titles.</summary>
public static class DocPaths
{
    public static string Key(string folder, string title) => (folder.Length > 0 ? folder + "/" + title : title).ToLowerInvariant();

    /// <summary>Trims and checks a title. Titles can't contain characters that would break links or paths.</summary>
    public static string? NormalizeTitle(string? title, out string? error)
    {
        var trimmed = (title ?? "").Trim();
        error = trimmed.Length == 0 ? "A title is required."
            : trimmed.Length > Doc.MaxTitleLength ? $"Titles can be at most {Doc.MaxTitleLength} characters."
            : trimmed.IndexOfAny(['[', ']', '|', '#', '/', '\\', '^']) >= 0 ? "Titles can't contain [ ] | # / \\ or ^."
            : trimmed.Any(char.IsControl) ? "Titles can't contain control characters."
            : null;
        return error is null ? trimmed : null;
    }

    /// <summary>Normalises <c>" a / b/ "</c> to <c>a/b</c>. Empty means the top level.</summary>
    public static string? NormalizeFolder(string? folder, out string? error)
    {
        var parts = (folder ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var joined = string.Join('/', parts);
        error = joined.Length > Doc.MaxFolderLength ? $"Folder paths can be at most {Doc.MaxFolderLength} characters."
            : parts.Any(p => p.IndexOfAny(['[', ']', '|', '#', '\\', '^']) >= 0 || p is "." or ".." || p.Any(char.IsControl))
                ? "Folder names can't contain [ ] | # \\ or ^."
            : null;
        return error is null ? joined : null;
    }

    /// <summary>True if <paramref name="path"/> is <paramref name="folder"/> or inside it.</summary>
    public static bool IsWithin(string path, string folder) =>
        folder.Length == 0 || path.Equals(folder, StringComparison.OrdinalIgnoreCase) || path.StartsWith(folder + "/", StringComparison.OrdinalIgnoreCase);
}
