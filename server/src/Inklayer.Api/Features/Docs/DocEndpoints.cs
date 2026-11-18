using Inklayer.Api.Access;
using Inklayer.Api.Features.Live;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Docs;

/// <param name="DisplayName">The name they chose to be shown as, or their real name.</param>
/// <param name="FullName">Their real name, from their sign-in provider (shown on hover).</param>
public sealed record DocActor(Guid Id, string DisplayName, string? FullName = null);

public sealed record DocSummaryResponse(Guid Id, string Folder, string Title, DateTime UpdatedAt, IReadOnlyList<string> Tags);

/// <param name="Folders">Every folder, including ones that only exist because a doc is in them, sorted.</param>
public sealed record DocTreeResponse(IReadOnlyList<string> Folders, IReadOnlyList<DocSummaryResponse> Docs, bool CanEdit);

public sealed record DocLinkResponse(string Text, Guid? DocId, string? Title, string? Folder);

public sealed record DocCommentLinkResponse(Guid AnnotationId, Guid ProjectId, string ProjectName, string? PageUrl, string Body, string Status, DocActor Author);

/// <param name="Backlinks">Docs that link here.</param>
/// <param name="CommentBacklinks">Page comments that link here, in projects the caller can view.</param>
/// <param name="Links">Docs this doc links to, including ones that don't exist yet (<c>DocId</c> null).</param>
/// <param name="CommentLinks">Comments this doc links to (ids only; <c>GET /api/annotations/{id}</c> has the details).</param>
public sealed record DocResponse(
    Guid Id, Guid OrganizationId, string Folder, string Title, int Version, DateTime CreatedAt, DateTime UpdatedAt, DocActor? UpdatedBy,
    bool CanEdit, IReadOnlyList<string> Tags, IReadOnlyList<DocSummaryResponse> Backlinks, IReadOnlyList<DocCommentLinkResponse> CommentBacklinks,
    IReadOnlyList<DocLinkResponse> Links, IReadOnlyList<Guid> CommentLinks);

/// <param name="RelinkDocs">After a rename or move: docs whose text links the old name. The client that renamed rewrites those links.</param>
public sealed record DocChangedResponse(DocResponse Doc, IReadOnlyList<Guid> RelinkDocs);

public sealed record CreateDocRequest(string? Folder, string Title);

public sealed record UpdateDocRequest(int Version, string? Title, string? Folder);

public sealed record FolderRequest(string Path);

public sealed record MoveFolderRequest(string From, string To);

public sealed record DocRevisionResponse(Guid Id, int Version, string Action, DocActor Actor, DateTime OccurredAt, string Folder, string Title);

public sealed record DocRevisionContentResponse(Guid Id, int Version, string Action, DocActor Actor, DateTime OccurredAt, string Folder, string Title, string Content);

public sealed record DocSearchResultResponse(Guid Id, string Folder, string Title, string Snippet);

public sealed record DocTagCountResponse(string Tag, int Count);

public sealed record DocGraphNode(string Id, string Kind, string Label, Guid? DocId, Guid? AnnotationId, string? Folder);

public sealed record DocGraphEdge(string Source, string Target);

public sealed record DocGraphResponse(IReadOnlyList<DocGraphNode> Nodes, IReadOnlyList<DocGraphEdge> Edges);

/// <summary>
/// Docs: an organisation's knowledge base of markdown notes, Obsidian-style. Everyone in the organisation can read them;
/// Commenters and above create, rename, move and delete them. The text itself is edited live through the docs hub.
/// </summary>
internal static class DocEndpoints
{
    public static IEndpointRouteBuilder MapDocEndpoints(this IEndpointRouteBuilder app)
    {
        var byOrg = app.MapGroup("/api/orgs/{orgId:guid}/docs").WithTags("Docs").RequireAuthorization();
        byOrg.MapGet("/", TreeAsync).WithSummary("Folders and docs, with tags");
        byOrg.MapPost("/", CreateAsync).WithSummary("Create an empty doc (Commenter and above)");
        byOrg.MapPost("/folders", CreateFolderAsync).WithSummary("Create an empty folder");
        byOrg.MapPatch("/folders", MoveFolderAsync).WithSummary("Rename or move a folder, with everything in it");
        byOrg.MapDelete("/folders", DeleteFolderAsync).WithSummary("Delete an empty folder: ?path=");
        byOrg.MapGet("/search", SearchAsync).WithSummary("Full-text search: ?q=");
        byOrg.MapGet("/lookup", LookupAsync).WithSummary("Docs whose title matches ?q=, for link suggestions");
        byOrg.MapGet("/tags", TagsAsync).WithSummary("Tags with how many docs have each");
        byOrg.MapGet("/graph", GraphAsync).WithSummary("Docs and comments as nodes, links as edges");

        // Live co-editing; WebSockets only, signed in with a presence ticket like the presence hub.
        app.MapHub<DocsHub>(Presence.PresenceEndpoints.DocsHubPath, o => o.Transports = Microsoft.AspNetCore.Http.Connections.HttpTransportType.WebSockets);

        var docs = app.MapGroup("/api/docs").WithTags("Docs").RequireAuthorization();
        docs.MapGet("/{docId:guid}", GetAsync).WithSummary("A doc's details, links and backlinks (the text comes from the docs hub)");
        docs.MapPatch("/{docId:guid}", UpdateAsync).WithSummary("Rename or move a doc");
        docs.MapDelete("/{docId:guid}", DeleteAsync).WithSummary("Delete a doc: ?version=");
        docs.MapGet("/{docId:guid}/history", HistoryAsync);
        docs.MapGet("/{docId:guid}/history/{revisionId:guid}", RevisionAsync);
        return app;
    }

    /* ------------------------------------------------------------------ the tree */

    internal static async Task<IResult> TreeAsync(Guid orgId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var docs = await db.Docs.AsNoTracking().Where(d => d.OrganizationId == orgId && d.DeletedAt == null)
            .Select(d => new { d.Id, d.Folder, d.Title, d.UpdatedAt }).ToListAsync(ct);
        var tags = await TagsByDocAsync(db, orgId, ct);
        var folders = await FoldersAsync(db, orgId, ct);
        return TypedResults.Ok(new DocTreeResponse(
            folders,
            [.. docs.OrderBy(d => d.Folder, StringComparer.OrdinalIgnoreCase).ThenBy(d => d.Title, StringComparer.OrdinalIgnoreCase)
                .Select(d => new DocSummaryResponse(d.Id, d.Folder, d.Title, d.UpdatedAt, tags.GetValueOrDefault(d.Id, [])))],
            check.Role.Grants(Permission.Comment)));
    }

    internal static async Task<IResult> CreateAsync(
        Guid orgId, CreateDocRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (Validate(request.Folder, request.Title, out var folder, out var title) is { } invalid)
        {
            return invalid;
        }

        if (await db.Docs.AnyAsync(d => d.OrganizationId == orgId && d.DeletedAt == null && d.PathKey == DocPaths.Key(folder, title), ct))
        {
            return Taken(folder, title);
        }

        var userId = currentUser.Id!.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        var doc = new Doc { OrganizationId = orgId, CreatedByUserId = userId, CreatedAt = now, UpdatedByUserId = userId, UpdatedAt = now };
        doc.Place(folder, title);

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        db.Docs.Add(doc);
        db.DocRevisions.Add(Revision(doc, DocActions.Created, userId, now));
        await db.SaveChangesAsync(ct);
        await indexer.IndexDocAsync(doc, ct);
        await indexer.RelinkAsync(orgId, [doc.PathKey, doc.TitleKey], ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return TypedResults.Created($"/api/docs/{doc.Id}", new DocSummaryResponse(doc.Id, doc.Folder, doc.Title, doc.UpdatedAt, []));
    }

    /* ------------------------------------------------------------------ one doc */

    internal static async Task<IResult> GetAsync(Guid docId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var doc = await db.Docs.AsNoTracking().SingleOrDefaultAsync(d => d.Id == docId && d.DeletedAt == null, ct);
        if (doc is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckOrganizationAsync(doc.OrganizationId, Permission.View, ct);
        return check.IsAllowed ? TypedResults.Ok(await ResponseAsync(doc, check.Role, currentUser, db, ct)) : check.Denied!;
    }

    internal static async Task<IResult> UpdateAsync(
        Guid docId, UpdateDocRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var doc = await db.Docs.SingleOrDefaultAsync(d => d.Id == docId && d.DeletedAt == null, ct);
        if (doc is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckOrganizationAsync(doc.OrganizationId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (request.Version != doc.Version)
        {
            return Conflict("Someone else renamed or moved this doc. Reload to see the change.");
        }

        if (Validate(request.Folder ?? doc.Folder, request.Title ?? doc.Title, out var folder, out var title) is { } invalid)
        {
            return invalid;
        }

        var newKey = DocPaths.Key(folder, title);
        if (newKey != doc.PathKey && await db.Docs.AnyAsync(d => d.OrganizationId == doc.OrganizationId && d.DeletedAt == null && d.PathKey == newKey && d.Id != doc.Id, ct))
        {
            return Taken(folder, title);
        }

        var (oldPathKey, oldTitleKey) = (doc.PathKey, doc.TitleKey);
        var renamed = !string.Equals(title, doc.Title, StringComparison.Ordinal);
        var moved = !string.Equals(folder, doc.Folder, StringComparison.Ordinal);
        if (!renamed && !moved)
        {
            return TypedResults.Ok(new DocChangedResponse(await ResponseAsync(doc, check.Role, currentUser, db, ct), []));
        }

        // Docs that link the old name, found before the links are resolved again.
        var relink = await db.DocLinks.Where(l => l.TargetDocId == doc.Id && l.SourceDocId != null && l.SourceDocId != doc.Id)
            .Select(l => l.SourceDocId!.Value).Distinct().ToListAsync(ct);

        var userId = currentUser.Id!.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        doc.Place(folder, title);
        doc.Version++;
        doc.UpdatedAt = now;
        doc.UpdatedByUserId = userId;
        db.DocRevisions.Add(Revision(doc, renamed ? DocActions.Renamed : DocActions.Moved, userId, now));

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return Conflict("Someone else renamed or moved this doc. Reload to see the change.");
        }

        await indexer.IndexDocAsync(doc, ct);
        await RewriteCommentsAsync(db, indexer, [new DocMove(doc.Id, oldPathKey, oldTitleKey, doc.Folder, doc.Title)], userId, now, ct);
        await indexer.RelinkAsync(doc.OrganizationId, [oldPathKey, oldTitleKey, doc.PathKey, doc.TitleKey], ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return TypedResults.Ok(new DocChangedResponse(await ResponseAsync(doc, check.Role, currentUser, db, ct), relink));
    }

    internal static async Task<IResult> DeleteAsync(
        Guid docId, int version, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var doc = await db.Docs.SingleOrDefaultAsync(d => d.Id == docId && d.DeletedAt == null, ct);
        if (doc is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckOrganizationAsync(doc.OrganizationId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (version != doc.Version)
        {
            return Conflict("Someone else changed this doc. Reload and try again.");
        }

        var userId = currentUser.Id!.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        doc.DeletedAt = now;
        doc.Version++;
        doc.UpdatedAt = now;
        doc.UpdatedByUserId = userId;
        db.DocRevisions.Add(Revision(doc, DocActions.Deleted, userId, now));

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.SaveChangesAsync(ct);
        await indexer.IndexDocAsync(doc, ct);
        await indexer.RelinkAsync(doc.OrganizationId, [doc.PathKey, doc.TitleKey], ct);
        await db.DocUpdates.Where(u => u.DocId == doc.Id).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return TypedResults.NoContent();
    }

    internal static async Task<IResult> HistoryAsync(Guid docId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await ReadableDocAsync(docId, access, db, ct) is { } denied)
        {
            return denied;
        }

        var rows = await db.DocRevisions.AsNoTracking().Where(r => r.DocId == docId).OrderByDescending(r => r.OccurredAt).Take(200).ToListAsync(ct);
        var actors = await ActorsAsync(db, rows.Select(r => r.ActorUserId), ct);
        return TypedResults.Ok(rows.Select(r => new DocRevisionResponse(r.Id, r.Version, r.Action, actors[r.ActorUserId], r.OccurredAt, r.Folder, r.Title)).ToList());
    }

    private static async Task<IResult> RevisionAsync(Guid docId, Guid revisionId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (await ReadableDocAsync(docId, access, db, ct) is { } denied)
        {
            return denied;
        }

        var r = await db.DocRevisions.AsNoTracking().SingleOrDefaultAsync(r => r.DocId == docId && r.Id == revisionId, ct);
        if (r is null)
        {
            return TypedResults.NotFound();
        }

        var actors = await ActorsAsync(db, [r.ActorUserId], ct);
        return TypedResults.Ok(new DocRevisionContentResponse(r.Id, r.Version, r.Action, actors[r.ActorUserId], r.OccurredAt, r.Folder, r.Title, r.Content));
    }

    /* ------------------------------------------------------------------ folders */

    private static async Task<IResult> CreateFolderAsync(Guid orgId, FolderRequest request, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (DocPaths.NormalizeFolder(request.Path, out var error) is not { Length: > 0 } path)
        {
            return Invalid("path", error ?? "A folder name is required.");
        }

        if (!(await FoldersAsync(db, orgId, ct)).Contains(path, StringComparer.OrdinalIgnoreCase))
        {
            db.DocFolders.Add(new DocFolder { OrganizationId = orgId, Path = path, PathKey = path.ToLowerInvariant() });
            await db.SaveChangesAsync(ct);
        }

        return TypedResults.Created($"/api/orgs/{orgId}/docs", new { path });
    }

    private static async Task<IResult> MoveFolderAsync(
        Guid orgId, MoveFolderRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (DocPaths.NormalizeFolder(request.From, out _) is not { Length: > 0 } from)
        {
            return Invalid("from", "Which folder?");
        }

        if (DocPaths.NormalizeFolder(request.To, out var error) is not { Length: > 0 } to)
        {
            return Invalid("to", error ?? "A folder name is required.");
        }

        if (DocPaths.IsWithin(to, from) && !to.Equals(from, StringComparison.OrdinalIgnoreCase))
        {
            return Invalid("to", "A folder can't go inside itself.");
        }

        var moving = await db.Docs.Where(d => d.OrganizationId == orgId && d.DeletedAt == null).ToListAsync(ct);
        moving = [.. moving.Where(d => DocPaths.IsWithin(d.Folder, from))];
        var others = await db.Docs.AsNoTracking().Where(d => d.OrganizationId == orgId && d.DeletedAt == null).Select(d => new { d.Id, d.PathKey }).ToListAsync(ct);
        var renamedFolder = (string f) => to + f[from.Length..];
        var movingIds = moving.Select(d => d.Id).ToHashSet();
        foreach (var doc in moving)
        {
            var key = DocPaths.Key(renamedFolder(doc.Folder), doc.Title);
            if (others.Any(o => o.PathKey == key && !movingIds.Contains(o.Id)))
            {
                return Taken(renamedFolder(doc.Folder), doc.Title);
            }
        }

        var userId = currentUser.Id!.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        var keys = new List<string>();
        var moves = new List<DocMove>();
        var relink = new HashSet<Guid>();
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        foreach (var doc in moving)
        {
            keys.Add(doc.PathKey);
            relink.UnionWith(await db.DocLinks.Where(l => l.TargetDocId == doc.Id && l.SourceDocId != null && !movingIds.Contains(l.SourceDocId.Value))
                .Select(l => l.SourceDocId!.Value).ToListAsync(ct));
            var oldPathKey = doc.PathKey;
            doc.Place(renamedFolder(doc.Folder), doc.Title);
            moves.Add(new DocMove(doc.Id, oldPathKey, doc.TitleKey, doc.Folder, doc.Title));
            doc.Version++;
            doc.UpdatedAt = now;
            doc.UpdatedByUserId = userId;
            keys.Add(doc.PathKey);
            db.DocRevisions.Add(Revision(doc, DocActions.Moved, userId, now));
        }

        var folderRows = await db.DocFolders.Where(f => f.OrganizationId == orgId).ToListAsync(ct);
        foreach (var row in folderRows.Where(f => DocPaths.IsWithin(f.Path, from)))
        {
            row.Path = renamedFolder(row.Path);
            row.PathKey = row.Path.ToLowerInvariant();
        }

        // Keep the folder even if it has no docs.
        if (!folderRows.Any(f => string.Equals(f.Path, to, StringComparison.OrdinalIgnoreCase)))
        {
            db.DocFolders.Add(new DocFolder { OrganizationId = orgId, Path = to, PathKey = to.ToLowerInvariant() });
        }

        foreach (var duplicate in folderRows.GroupBy(f => f.PathKey).SelectMany(g => g.Skip(1)))
        {
            db.DocFolders.Remove(duplicate);
        }

        await db.SaveChangesAsync(ct);
        await RewriteCommentsAsync(db, indexer, moves, userId, now, ct);
        await indexer.RelinkAsync(orgId, keys, ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return TypedResults.Ok(new { relinkDocs = relink });
    }

    private static async Task<IResult> DeleteFolderAsync(Guid orgId, string path, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (DocPaths.NormalizeFolder(path, out _) is not { Length: > 0 } folder)
        {
            return Invalid("path", "Which folder?");
        }

        var docFolders = await db.Docs.Where(d => d.OrganizationId == orgId && d.DeletedAt == null).Select(d => d.Folder).Distinct().ToListAsync(ct);
        if (docFolders.Any(f => DocPaths.IsWithin(f, folder)))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "Only empty folders can be deleted. Move or delete its docs first.");
        }

        var rows = await db.DocFolders.Where(f => f.OrganizationId == orgId).ToListAsync(ct);
        db.DocFolders.RemoveRange(rows.Where(f => DocPaths.IsWithin(f.Path, folder)));
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    /* ------------------------------------------------------------------ finding docs */

    internal static async Task<IResult> SearchAsync(Guid orgId, string? q, AccessService access, InklayerDbContext db, DocIndexer indexer, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var hits = await indexer.SearchAsync(orgId, q ?? "", 30, ct);
        var ids = hits.Select(h => h.DocId).ToList();
        var docs = await db.Docs.AsNoTracking().Where(d => ids.Contains(d.Id) && d.DeletedAt == null).ToDictionaryAsync(d => d.Id, ct);
        return TypedResults.Ok(hits.Where(h => docs.ContainsKey(h.DocId))
            .Select(h => new DocSearchResultResponse(h.DocId, docs[h.DocId].Folder, docs[h.DocId].Title, h.Snippet)).ToList());
    }

    private static async Task<IResult> LookupAsync(Guid orgId, string? q, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var term = (q ?? "").Trim().ToLowerInvariant();
        var docs = await db.Docs.AsNoTracking()
            .Where(d => d.OrganizationId == orgId && d.DeletedAt == null && (term.Length == 0 || d.TitleKey.Contains(term)))
            .Select(d => new { d.Id, d.Folder, d.Title, d.TitleKey, d.UpdatedAt })
            .ToListAsync(ct);
        return TypedResults.Ok(docs
            .OrderBy(d => d.TitleKey.StartsWith(term, StringComparison.Ordinal) ? 0 : 1)
            .ThenByDescending(d => d.UpdatedAt)
            .Take(10)
            .Select(d => new DocSummaryResponse(d.Id, d.Folder, d.Title, d.UpdatedAt, []))
            .ToList());
    }

    internal static async Task<IResult> TagsAsync(Guid orgId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var tags = await db.DocTags.AsNoTracking().Where(t => t.OrganizationId == orgId).GroupBy(t => t.Tag)
            .Select(g => new DocTagCountResponse(g.Key, g.Count())).ToListAsync(ct);
        return TypedResults.Ok(tags.OrderByDescending(t => t.Count).ThenBy(t => t.Tag, StringComparer.Ordinal).ToList());
    }

    private static async Task<IResult> GraphAsync(Guid orgId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var docs = await db.Docs.AsNoTracking().Where(d => d.OrganizationId == orgId && d.DeletedAt == null)
            .Select(d => new { d.Id, d.Title, d.Folder }).ToListAsync(ct);
        var links = await db.DocLinks.AsNoTracking().Where(l => l.OrganizationId == orgId).ToListAsync(ct);

        // Comments only appear if the caller can see them.
        var visibleProjects = (await LiveEndpoints.VisibleProjectsAsync(currentUser, db, ct) ?? []).Select(v => v.Project.Id).ToHashSet();
        var commentIds = links.Select(l => l.SourceAnnotationId ?? l.TargetAnnotationId).OfType<Guid>().Distinct().ToList();
        var comments = await db.Annotations.AsNoTracking()
            .Where(a => commentIds.Contains(a.Id) && a.DeletedAt == null && a.OrganizationId == orgId)
            .Select(a => new { a.Id, a.Body, a.ProjectId }).ToListAsync(ct);
        comments = [.. comments.Where(c => visibleProjects.Contains(c.ProjectId))];

        var nodes = docs.Select(d => new DocGraphNode($"d:{d.Id}", "doc", d.Title, d.Id, null, d.Folder))
            .Concat(comments.Select(c => new DocGraphNode($"c:{c.Id}", "comment", Preview(c.Body, 60), null, c.Id, null)))
            .ToList();
        var ids = nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);
        var edges = links
            .Select(l => new DocGraphEdge(
                l.SourceDocId is { } sd ? $"d:{sd}" : $"c:{l.SourceAnnotationId}",
                l.TargetDocId is { } td ? $"d:{td}" : l.TargetAnnotationId is { } ta ? $"c:{ta}" : ""))
            .Where(e => ids.Contains(e.Source) && ids.Contains(e.Target) && e.Source != e.Target)
            .Distinct()
            .ToList();
        return TypedResults.Ok(new DocGraphResponse(nodes, edges));
    }

    /* ------------------------------------------------------------------ helpers */

    private sealed record DocMove(Guid DocId, string OldPathKey, string OldTitleKey, string NewFolder, string NewTitle);

    /// <summary>
    /// After docs were renamed or moved: rewrites the [[links]] in page comments that pointed at them, so they still do.
    /// (Links in docs are rewritten by the client, through live editing.) Call before the links are resolved again.
    /// </summary>
    private static async Task RewriteCommentsAsync(InklayerDbContext db, DocIndexer indexer, IReadOnlyList<DocMove> moves, Guid userId, DateTime now, CancellationToken ct)
    {
        var docIds = moves.Select(m => m.DocId).ToList();
        var annotationIds = await db.DocLinks
            .Where(l => l.SourceAnnotationId != null && l.TargetDocId != null && docIds.Contains(l.TargetDocId.Value))
            .Select(l => l.SourceAnnotationId!.Value).Distinct().ToListAsync(ct);
        if (annotationIds.Count == 0)
        {
            return;
        }

        var byPath = moves.ToDictionary(m => m.OldPathKey, StringComparer.Ordinal);
        var byTitle = moves.Where(m => !string.Equals(m.OldTitleKey, m.NewTitle, StringComparison.OrdinalIgnoreCase)).GroupBy(m => m.OldTitleKey).ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);
        var annotations = await db.Annotations.Where(a => annotationIds.Contains(a.Id) && a.DeletedAt == null).ToListAsync(ct);
        var changed = new List<Domain.Annotations.Annotation>();
        foreach (var annotation in annotations)
        {
            var body = DocMarkdown.RewriteLinks(annotation.Body, link => link.Key!.Contains('/', StringComparison.Ordinal)
                ? byPath.TryGetValue(link.Key, out var moved) ? (moved.NewFolder.Length > 0 ? $"{moved.NewFolder}/{moved.NewTitle}" : moved.NewTitle) : null
                : byTitle.TryGetValue(link.Key, out var renamed) ? renamed.NewTitle : null);
            if (body == annotation.Body)
            {
                continue;
            }

            annotation.Body = body;
            annotation.Version++;
            annotation.UpdatedAt = now;
            db.AnnotationRevisions.Add(Annotations.AnnotationEndpoints.Revision(annotation, Domain.Annotations.AnnotationActions.Updated, userId, now));
            changed.Add(annotation);
        }

        await db.SaveChangesAsync(ct);
        foreach (var annotation in changed)
        {
            await indexer.IndexCommentAsync(annotation, ct);
        }
    }

    internal static async Task<DocResponse> ResponseAsync(Doc doc, Role role, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var tags = await db.DocTags.AsNoTracking().Where(t => t.DocId == doc.Id).Select(t => t.Tag).OrderBy(t => t).ToListAsync(ct);

        var incoming = await db.DocLinks.AsNoTracking().Where(l => l.TargetDocId == doc.Id).ToListAsync(ct);
        var sourceDocIds = incoming.Select(l => l.SourceDocId).OfType<Guid>().Where(id => id != doc.Id).Distinct().ToList();
        var backlinks = await db.Docs.AsNoTracking().Where(d => sourceDocIds.Contains(d.Id) && d.DeletedAt == null)
            .OrderBy(d => d.Title).Select(d => new DocSummaryResponse(d.Id, d.Folder, d.Title, d.UpdatedAt, new List<string>())).ToListAsync(ct);

        var sourceCommentIds = incoming.Select(l => l.SourceAnnotationId).OfType<Guid>().Distinct().ToList();
        var commentBacklinks = await CommentsAsync(sourceCommentIds, currentUser, db, ct);

        var outgoing = await db.DocLinks.AsNoTracking().Where(l => l.SourceDocId == doc.Id).ToListAsync(ct);
        var targetIds = outgoing.Select(l => l.TargetDocId).OfType<Guid>().ToList();
        var targets = await db.Docs.AsNoTracking().Where(d => targetIds.Contains(d.Id)).ToDictionaryAsync(d => d.Id, ct);
        var links = outgoing.Where(l => l.TargetAnnotationId is null)
            .Select(l => l.TargetDocId is { } id && targets.TryGetValue(id, out var t)
                ? new DocLinkResponse(l.Text, id, t.Title, t.Folder)
                : new DocLinkResponse(l.Text, null, null, null))
            .ToList();
        var commentLinks = outgoing.Select(l => l.TargetAnnotationId).OfType<Guid>().Distinct().ToList();

        var updatedBy = await db.Users.AsNoTracking().Where(u => u.Id == doc.UpdatedByUserId).Select(u => new DocActor(u.Id, u.PreferredName ?? u.DisplayName, u.DisplayName)).SingleOrDefaultAsync(ct);
        return new DocResponse(doc.Id, doc.OrganizationId, doc.Folder, doc.Title, doc.Version, doc.CreatedAt, doc.UpdatedAt, updatedBy,
            role.Grants(Permission.Comment), tags, backlinks, commentBacklinks, links, commentLinks);
    }

    /// <summary>The comments, among <paramref name="ids"/>, that the caller can see.</summary>
    internal static async Task<List<DocCommentLinkResponse>> CommentsAsync(IReadOnlyCollection<Guid> ids, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (ids.Count == 0)
        {
            return [];
        }

        var visible = (await LiveEndpoints.VisibleProjectsAsync(currentUser, db, ct) ?? []).ToDictionary(v => v.Project.Id, v => v.Project.Name);
        var comments = await db.Annotations.AsNoTracking().Where(a => ids.Contains(a.Id) && a.DeletedAt == null).ToListAsync(ct);
        comments = [.. comments.Where(a => visible.ContainsKey(a.ProjectId)).OrderByDescending(a => a.CreatedAt)];
        var authors = await ActorsAsync(db, comments.Select(a => a.AuthorUserId), ct);
        return [.. comments.Select(a => new DocCommentLinkResponse(
            a.Id, a.ProjectId, visible[a.ProjectId], a.PageUrl, Preview(a.Body, 280), a.Status.ToString(), authors[a.AuthorUserId]))];
    }

    internal static DocRevision Revision(Doc doc, string action, Guid actorUserId, DateTime now) => new()
    {
        DocId = doc.Id, OrganizationId = doc.OrganizationId, Version = doc.Version, Action = action, ActorUserId = actorUserId,
        OccurredAt = now, Folder = doc.Folder, Title = doc.Title, Content = doc.Content,
    };

    internal static async Task<Dictionary<Guid, DocActor>> ActorsAsync(InklayerDbContext db, IEnumerable<Guid> ids, CancellationToken ct)
    {
        var distinct = ids.Distinct().ToList();
        var found = await db.Users.AsNoTracking().Where(u => distinct.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => new DocActor(u.Id, u.PreferredName ?? u.DisplayName, u.DisplayName), ct);
        foreach (var id in distinct.Where(id => !found.ContainsKey(id)))
        {
            found[id] = new DocActor(id, "Unknown");
        }

        return found;
    }

    private static async Task<IResult?> ReadableDocAsync(Guid docId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var orgId = await db.Docs.Where(d => d.Id == docId).Select(d => (Guid?)d.OrganizationId).SingleOrDefaultAsync(ct);
        if (orgId is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckOrganizationAsync(orgId.Value, Permission.View, ct);
        return check.IsAllowed ? null : check.Denied;
    }

    private static async Task<Dictionary<Guid, List<string>>> TagsByDocAsync(InklayerDbContext db, Guid orgId, CancellationToken ct) =>
        (await db.DocTags.AsNoTracking().Where(t => t.OrganizationId == orgId).ToListAsync(ct))
            .GroupBy(t => t.DocId).ToDictionary(g => g.Key, g => g.Select(t => t.Tag).Order(StringComparer.Ordinal).ToList());

    /// <summary>Every folder: saved empty ones, and those (and their parents) that contain docs.</summary>
    private static async Task<List<string>> FoldersAsync(InklayerDbContext db, Guid orgId, CancellationToken ct)
    {
        var paths = await db.DocFolders.AsNoTracking().Where(f => f.OrganizationId == orgId).Select(f => f.Path).ToListAsync(ct);
        paths.AddRange(await db.Docs.AsNoTracking().Where(d => d.OrganizationId == orgId && d.DeletedAt == null && d.Folder != "").Select(d => d.Folder).Distinct().ToListAsync(ct));
        var all = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var path in paths)
        {
            var parts = path.Split('/');
            for (var i = 1; i <= parts.Length; i++)
            {
                all.Add(string.Join('/', parts[..i]));
            }
        }

        return [.. all];
    }

    private static IResult? Validate(string? folderInput, string? titleInput, out string folder, out string title)
    {
        folder = DocPaths.NormalizeFolder(folderInput, out var folderError) ?? "";
        title = DocPaths.NormalizeTitle(titleInput, out var titleError) ?? "";
        return titleError is not null ? Invalid("title", titleError) : folderError is not null ? Invalid("folder", folderError) : null;
    }

    private static IResult Invalid(string field, string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });

    private static IResult Taken(string folder, string title) =>
        TypedResults.Problem(statusCode: StatusCodes.Status409Conflict,
            title: folder.Length > 0 ? $"There's already a doc called \"{title}\" in {folder}." : $"There's already a doc called \"{title}\".");

    private static IResult Conflict(string title) => TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: title);

    internal static string Preview(string text, int length) => text.Length > length ? text[..length] + "…" : text;
}
