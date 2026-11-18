using System.Text.RegularExpressions;

namespace Inklayer.Domain.Docs;

/// <summary>A <c>[[link]]</c> found in markdown or a comment. Exactly one of <see cref="Target"/> and <see cref="CommentId"/> is set.</summary>
/// <param name="Target">The doc as written: <c>Title</c> or <c>Folder/Title</c>.</param>
/// <param name="Heading">After <c>#</c>, if any.</param>
/// <param name="Alias">After <c>|</c>, if any: the text to show.</param>
public sealed record WikiLink(string? Target, string? Heading, string? Alias, Guid? CommentId, bool Embed)
{
    /// <summary>The lowercase key used to find the doc: <c>title</c> or <c>folder/title</c>.</summary>
    public string? Key => Target?.ToLowerInvariant();
}

/// <summary>
/// Finds links and tags in markdown, following Obsidian's syntax:
/// <list type="bullet">
/// <item><c>[[Title]]</c>, <c>[[Folder/Title]]</c>, <c>[[Title#Heading]]</c>, <c>[[Title|shown text]]</c>, and <c>![[...]]</c> to embed.</item>
/// <item><c>[[comment:&lt;id&gt;]]</c> links a page comment.</item>
/// <item><c>#tag</c> and <c>#nested/tag</c>, at the start of a line or after a space; not headings, not all digits.</item>
/// </list>
/// Nothing inside fenced code blocks or inline code counts. The client has the same rules (<c>docMarkdown.ts</c>).
/// </summary>
public static partial class DocMarkdown
{
    public const string CommentPrefix = "comment:";

    public static (IReadOnlyList<WikiLink> Links, IReadOnlyList<string> Tags) Extract(string? markdown)
    {
        var links = new List<WikiLink>();
        var tags = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var line in ProseLines(markdown ?? ""))
        {
            foreach (Match m in LinkPattern().Matches(line))
            {
                if (Parse(m.Groups["inner"].Value, m.Groups["embed"].Success) is { } link)
                {
                    links.Add(link);
                }
            }

            // Tags can't come from inside a link.
            foreach (Match m in TagPattern().Matches(LinkPattern().Replace(line, " ")))
            {
                var tag = m.Groups["tag"].Value.TrimEnd('/');
                if (tag.Length > 0 && !tag.All(c => char.IsAsciiDigit(c) || c is '/' or '-' or '_'))
                {
                    tags.Add(tag.ToLowerInvariant());
                }
            }
        }

        return (links, [.. tags]);
    }

    /// <summary>The links in plain text, such as a comment body. Comments have no code blocks, but backticks still exclude.</summary>
    public static IReadOnlyList<WikiLink> Links(string? text) => Extract(text).Links;

    private static WikiLink? Parse(string inner, bool embed)
    {
        string? alias = null;
        var pipe = inner.IndexOf('|', StringComparison.Ordinal);
        if (pipe >= 0)
        {
            alias = inner[(pipe + 1)..].Trim();
            inner = inner[..pipe];
        }

        inner = inner.Trim();
        if (inner.StartsWith(CommentPrefix, StringComparison.OrdinalIgnoreCase))
        {
            return Guid.TryParse(inner[CommentPrefix.Length..].Trim(), out var id) ? new WikiLink(null, null, alias, id, embed) : null;
        }

        string? heading = null;
        var hash = inner.IndexOf('#', StringComparison.Ordinal);
        if (hash >= 0)
        {
            heading = inner[(hash + 1)..].Trim();
            inner = inner[..hash].Trim();
        }

        // [[#Heading]] links within the same doc: not a link to another doc.
        if (inner.Length == 0)
        {
            return null;
        }

        var target = string.Join('/', inner.Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        if (target.EndsWith(".md", StringComparison.OrdinalIgnoreCase))
        {
            target = target[..^3];
        }

        return target.Length is 0 or > Doc.MaxFolderLength + Doc.MaxTitleLength ? null
            : new WikiLink(target, string.IsNullOrEmpty(heading) ? null : heading, string.IsNullOrEmpty(alias) ? null : alias, null, embed);
    }

    /// <summary>The lines outside fenced code blocks, with inline code blanked out.</summary>
    private static IEnumerable<string> ProseLines(string markdown)
    {
        string? fence = null;
        foreach (var raw in markdown.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            var trimmed = line.TrimStart();
            if (fence is null && (trimmed.StartsWith("```", StringComparison.Ordinal) || trimmed.StartsWith("~~~", StringComparison.Ordinal)))
            {
                fence = trimmed[..3];
                continue;
            }

            if (fence is not null)
            {
                if (trimmed.StartsWith(fence, StringComparison.Ordinal))
                {
                    fence = null;
                }

                continue;
            }

            yield return InlineCode().Replace(line, m => new string(' ', m.Length));
        }
    }

    [GeneratedRegex(@"(?<embed>!)?\[\[(?<inner>[^\[\]\n]+?)\]\]")]
    private static partial Regex LinkPattern();

    [GeneratedRegex(@"(?<=^|\s)#(?<tag>[\p{L}\p{N}_/-]+)")]
    private static partial Regex TagPattern();

    [GeneratedRegex(@"(`+)[^`]*?\1")]
    private static partial Regex InlineCode();
}
