using System.Text.RegularExpressions;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Docs;

/// <summary>
/// Keeps what is derived from docs' text up to date: links (to docs and comments), tags and the full-text index.
/// Call after the doc or comment itself is saved; then save again. Link targets are resolved within the organisation:
/// <c>[[Folder/Title]]</c> by path, <c>[[Title]]</c> by title (a top-level doc wins, then the first by path).
/// </summary>
public sealed partial class DocIndexer(InklayerDbContext db)
{
    /// <summary>Rebuilds a doc's outgoing links, tags and search entry from its <see cref="Doc.Content"/>.</summary>
    public async Task IndexDocAsync(Doc doc, CancellationToken ct)
    {
        await db.DocLinks.Where(l => l.SourceDocId == doc.Id).ExecuteDeleteAsync(ct);
        await db.DocTags.Where(t => t.DocId == doc.Id).ExecuteDeleteAsync(ct);
        var id = doc.Id.ToString();
        await db.Database.ExecuteSqlAsync($"DELETE FROM \"DocSearch\" WHERE \"DocId\" = {id}", ct);
        if (doc.DeletedAt is not null)
        {
            return;
        }

        var (links, tags) = DocMarkdown.Extract(doc.Content);
        await AddLinksAsync(doc.OrganizationId, links, l => new DocLink
        {
            OrganizationId = doc.OrganizationId, SourceDocId = doc.Id, TargetAnnotationId = l.CommentId, TargetKey = l.Key ?? "", Text = l.Target ?? "",
        }, ct);
        db.DocTags.AddRange(tags.Where(t => t.Length <= 100).Select(t => new DocTag { DocId = doc.Id, Tag = t, OrganizationId = doc.OrganizationId }));
        var org = doc.OrganizationId.ToString();
        await db.Database.ExecuteSqlAsync(
            $"INSERT INTO \"DocSearch\" (\"DocId\", \"OrganizationId\", \"Title\", \"Content\") VALUES ({id}, {org}, {doc.Title}, {doc.Content})", ct);
    }

    /// <summary>Rebuilds a comment's links to docs from its body and its replies. A deleted comment links nothing.</summary>
    public async Task IndexCommentAsync(Annotation annotation, CancellationToken ct)
    {
        await db.DocLinks.Where(l => l.SourceAnnotationId == annotation.Id).ExecuteDeleteAsync(ct);
        if (annotation.DeletedAt is not null)
        {
            return;
        }

        var replies = await db.AnnotationReplies.Where(r => r.AnnotationId == annotation.Id && r.DeletedAt == null).Select(r => r.Body).ToListAsync(ct);
        var links = DocMarkdown.Links(string.Join('\n', [annotation.Body, .. replies])).Where(l => l.Target is not null).ToList();
        await AddLinksAsync(annotation.OrganizationId, links, l => new DocLink
        {
            OrganizationId = annotation.OrganizationId, SourceAnnotationId = annotation.Id, TargetKey = l.Key!, Text = l.Target!,
        }, ct);
    }

    /// <summary>Resolves links again after docs with these keys were created, renamed, moved or deleted.</summary>
    public async Task RelinkAsync(Guid organizationId, IEnumerable<string> keys, CancellationToken ct)
    {
        var distinct = keys.Distinct(StringComparer.Ordinal).ToList();
        var links = await db.DocLinks.Where(l => l.OrganizationId == organizationId && l.TargetAnnotationId == null && distinct.Contains(l.TargetKey)).ToListAsync(ct);
        if (links.Count == 0)
        {
            return;
        }

        var targets = await ResolveAsync(organizationId, distinct, ct);
        foreach (var link in links)
        {
            link.TargetDocId = targets.GetValueOrDefault(link.TargetKey);
        }
    }

    /// <summary>The doc each key refers to, for keys that resolve.</summary>
    public async Task<Dictionary<string, Guid?>> ResolveAsync(Guid organizationId, IReadOnlyCollection<string> keys, CancellationToken ct)
    {
        var candidates = await db.Docs.AsNoTracking()
            .Where(d => d.OrganizationId == organizationId && d.DeletedAt == null && (keys.Contains(d.PathKey) || keys.Contains(d.TitleKey)))
            .Select(d => new { d.Id, d.PathKey, d.TitleKey, d.Folder })
            .ToListAsync(ct);
        return keys.ToDictionary(k => k, k => k.Contains('/', StringComparison.Ordinal)
            ? candidates.FirstOrDefault(c => c.PathKey == k)?.Id
            : candidates.Where(c => c.TitleKey == k).OrderBy(c => c.Folder.Length == 0 ? 0 : 1).ThenBy(c => c.PathKey, StringComparer.Ordinal).FirstOrDefault()?.Id,
            StringComparer.Ordinal);
    }

    /// <summary>Full-text search within an organisation. Each word matches as a prefix; all words must match.</summary>
    public async Task<List<(Guid DocId, string Snippet)>> SearchAsync(Guid organizationId, string query, int take, CancellationToken ct)
    {
        var words = Words().Matches(query).Select(m => m.Value).Take(8).ToList();
        if (words.Count == 0)
        {
            return [];
        }

        var match = string.Join(' ', words.Select(w => $"\"{w}\"*"));
        var org = organizationId.ToString();

        // \u0002 and \u0003 mark the matched words; the viewer turns them into highlights.
        var rows = await db.Database.SqlQuery<SearchRow>(
            $"SELECT \"DocId\", snippet(\"DocSearch\", 3, char(2), char(3), '…', 16) AS \"Snippet\" FROM \"DocSearch\" WHERE \"DocSearch\" MATCH {match} AND \"OrganizationId\" = {org} ORDER BY rank LIMIT {take}")
            .ToListAsync(ct);
        return [.. rows.Select(r => (Guid.Parse(r.DocId), r.Snippet))];
    }

    private async Task AddLinksAsync(Guid organizationId, IReadOnlyList<WikiLink> links, Func<WikiLink, DocLink> create, CancellationToken ct)
    {
        var keys = links.Where(l => l.Key is not null).Select(l => l.Key!).Distinct(StringComparer.Ordinal).ToList();
        var targets = keys.Count > 0 ? await ResolveAsync(organizationId, keys, ct) : [];

        // One row per distinct target.
        foreach (var link in links.DistinctBy(l => (l.Key, l.CommentId)).Take(500))
        {
            var row = create(link);
            row.TargetDocId = link.Key is null ? null : targets.GetValueOrDefault(link.Key);
            db.DocLinks.Add(row);
        }
    }

    private sealed record SearchRow(string DocId, string Snippet);

    [GeneratedRegex(@"[\p{L}\p{N}_]+")]
    private static partial Regex Words();
}
