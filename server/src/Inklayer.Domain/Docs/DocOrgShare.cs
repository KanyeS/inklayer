namespace Inklayer.Domain.Docs;

/// <summary>
/// Shares one doc with another organisation. There's still one doc: it stays in its own organisation (its home), and the other
/// organisation's members open the same live document, so the two can't drift apart.
/// <list type="bullet">
/// <item>Members of the other organisation read it; if <see cref="CanEdit"/>, those who are Commenter or above there edit its text too.</item>
/// <item>Only the home organisation renames, moves, deletes or restores it, and shares or stops sharing it. An Admin of the other
/// organisation can also take it out of theirs.</item>
/// </list>
/// </summary>
public sealed class DocOrgShare
{
    public required Guid DocId { get; init; }

    /// <summary>The organisation it's shared with (not the doc's own).</summary>
    public required Guid OrganizationId { get; init; }

    /// <summary>Whether that organisation's Commenters and above edit the text, or everyone there only reads it.</summary>
    public bool CanEdit { get; set; }

    public required Guid SharedByUserId { get; set; }

    public DateTime SharedAt { get; set; }
}
