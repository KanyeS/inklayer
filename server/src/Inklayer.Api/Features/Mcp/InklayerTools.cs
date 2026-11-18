using System.ComponentModel;
using Inklayer.Api.Access;
using Inklayer.Api.Activity;
using Inklayer.Api.Features.Annotations;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Features.Live;
using Inklayer.Api.Features.Me;
using Inklayer.Api.Features.Projects;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Inklayer.Api.Features.Mcp;

/// <summary>
/// What an MCP client (such as Claude) can do in Inklayer, as the person who signed it in. Every tool goes through the same
/// handlers and access checks as the app, so it can do exactly what that person's role allows.
/// </summary>
[McpServerToolType]
internal static class InklayerTools
{
    public const string Instructions = """
        Inklayer is a team's comments on live web pages plus an organisation knowledge base of markdown docs.
        - People belong to organisations; organisations have projects; page comments belong to a project and a page URL.
        - Comments have threads of replies and can be resolved. Comments and docs link each other: [[Doc title]] in a
          comment or doc links a doc; [[comment:<id>]] in a doc links a comment. #tags tag docs.
        - Docs live in folders per organisation and are co-edited live; your edits appear to anyone who has the doc open.
        - You act as the signed-in person: you can do what their role allows (Viewers read; Commenters and above reply,
          resolve and edit docs). Start with whoami to see their organisations.
        """;

    /* ------------------------------------------------------------------ who and where */

    [McpServerTool(Name = "whoami", ReadOnly = true), Description("The signed-in person and the organisations they belong to, with their role in each.")]
    public static async Task<string> WhoAmI(CurrentUser currentUser, InklayerDbContext db, FeatureSwitches features, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<MeResponse>(await MeEndpoints.MeAsync(currentUser, db, features, ct)));

    [McpServerTool(Name = "list_projects", ReadOnly = true), Description("Projects in an organisation. Page comments belong to projects.")]
    public static async Task<string> ListProjects(
        [Description("Organisation id (from whoami)")] Guid orgId, AccessService access, InklayerDbContext db, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<object>(await ProjectEndpoints.ListAsync(orgId, false, access, db, ct)));

    [McpServerTool(Name = "list_pages", ReadOnly = true), Description("Web pages in a project that have comments, with open and resolved counts, most recently active first.")]
    public static async Task<string> ListPages([Description("Project id")] Guid projectId, AccessService access, InklayerDbContext db, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<object>(await LiveEndpoints.PagesAsync(projectId, access, db, ct)));

    /* ------------------------------------------------------------------ comments */

    [McpServerTool(Name = "list_comments", ReadOnly = true), Description("The comments on a web page, across the person's projects, with replies and the docs they link.")]
    public static async Task<string> ListComments(
        [Description("The page's address, e.g. https://example.com/pricing")] string url, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var pages = ToolResults.Value<List<LivePageAnnotationsResponse>>(await LiveEndpoints.ListAsync(url, currentUser, db, ct));
        return ToolResults.ToJson(pages.Select(p => new { p.ProjectId, p.PageUrl, Comments = p.Annotations.Select(Summary) }));
    }

    [McpServerTool(Name = "get_comment", ReadOnly = true), Description("One page comment: its text, page, project, replies, and the docs that link it.")]
    public static async Task<string> GetComment([Description("Comment id")] Guid commentId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<AnnotationDetailResponse>(await AnnotationEndpoints.GetAsync(commentId, access, currentUser, db, ct)));

    [McpServerTool(Name = "list_open_comments", ReadOnly = true), Description(
        "Open (unresolved) comments in a project, newest first, optionally on one page, with replies, the page details captured with each " +
        "(browser, window size, element selector, console errors, failed requests) and whether it has a screenshot. Use this to find what to fix.")]
    public static async Task<string> ListOpenComments(
        [Description("Project id")] Guid projectId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct,
        [Description("Only comments on this page address (optional)")] string? url = null)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            ToolResults.Ok(check.Denied!);
        }

        var query = db.Annotations.AsNoTracking().Where(a => a.ProjectId == projectId && a.DeletedAt == null && a.Status == AnnotationStatus.Open);
        if (url is not null)
        {
            var keys = Domain.Projects.LivePageUrl.Candidates(url);
            query = query.Where(a => keys.Contains(a.PageUrl));
        }

        var annotations = await query.OrderByDescending(a => a.CreatedAt).Take(100).ToListAsync(ct);
        var userId = currentUser.Id!.Value;
        var authors = await AnnotationEndpoints.AuthorsAsync(db, annotations.Select(a => a.AuthorUserId), ct);
        var responses = await AnnotationEndpoints.EnrichAsync(db, [.. annotations.Select(a => AnnotationEndpoints.ToResponse(a, authors, check.Role, userId))], _ => check.Role, userId, ct);
        return ToolResults.ToJson(responses.Select(Summary));
    }

    [McpServerTool(Name = "get_comment_screenshot", ReadOnly = true), Description("The screenshot taken when a comment was made, around the commented element, as an image.")]
    public static async Task<IEnumerable<ContentBlock>> GetCommentScreenshot(
        [Description("Comment id")] Guid commentId, AccessService access, InklayerDbContext db, FeatureSwitches features, CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.BugContext, ct))
        {
            throw new McpException("Bug context (screenshots) is turned off on this server.");
        }

        var projectId = await db.Annotations.Where(a => a.Id == commentId && a.DeletedAt == null).Select(a => (Guid?)a.ProjectId).SingleOrDefaultAsync(ct);
        var check = projectId is null ? AccessResult.NotFound() : await access.CheckProjectAsync(projectId.Value, Permission.View, ct);
        if (!check.IsAllowed)
        {
            ToolResults.Ok(check.Denied!);
        }

        var screenshot = await db.AnnotationScreenshots.AsNoTracking().SingleOrDefaultAsync(s => s.AnnotationId == commentId, ct)
            ?? throw new McpException("This comment has no screenshot.");
        return [ImageContentBlock.FromBytes(screenshot.Bytes, screenshot.ContentType)];
    }

    [McpServerTool(Name = "reply_to_comment", OpenWorld = false), Description("Reply in a comment's thread, as the signed-in person. [[Doc title]] links a doc.")]
    public static async Task<string> ReplyToComment(
        [Description("Comment id")] Guid commentId, [Description("The reply")] string body,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<ReplyResponse>(
            await AnnotationEndpoints.CreateReplyAsync(commentId, new CreateReplyRequest(body), access, currentUser, db, indexer, clock, ct)));

    [McpServerTool(Name = "set_comment_status", Idempotent = true, OpenWorld = false), Description("Resolve a comment, or reopen it.")]
    public static async Task<string> SetCommentStatus(
        [Description("Comment id")] Guid commentId, [Description("true to resolve, false to reopen")] bool resolved,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var version = await VersionOfCommentAsync(db, commentId, ct);
        var request = new UpdateAnnotationRequest(version, null, null, resolved ? AnnotationStatus.Resolved : AnnotationStatus.Open, null, null, null);
        return ToolResults.ToJson(Summary(ToolResults.Value<AnnotationResponse>(await AnnotationEndpoints.UpdateAsync(commentId, request, access, currentUser, db, indexer, clock, ct))));
    }

    [McpServerTool(Name = "edit_comment", OpenWorld = false), Description("Change a comment's text. Only its author, or a project Admin, can.")]
    public static async Task<string> EditComment(
        [Description("Comment id")] Guid commentId, [Description("The new text")] string body,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var version = await VersionOfCommentAsync(db, commentId, ct);
        var request = new UpdateAnnotationRequest(version, body, null, null, null, null, null);
        return ToolResults.ToJson(Summary(ToolResults.Value<AnnotationResponse>(await AnnotationEndpoints.UpdateAsync(commentId, request, access, currentUser, db, indexer, clock, ct))));
    }

    [McpServerTool(Name = "delete_reply", Destructive = true, OpenWorld = false), Description("Delete a reply. Only its author, or a project Admin, can.")]
    public static async Task<string> DeleteReply(
        [Description("Reply id")] Guid replyId, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        ToolResults.Ok(await AnnotationEndpoints.DeleteReplyAsync(replyId, null, access, currentUser, db, indexer, clock, ct));
        return "Deleted.";
    }

    /* ------------------------------------------------------------------ docs: reading */

    [McpServerTool(Name = "list_docs", ReadOnly = true), Description("An organisation's docs and folders, with each doc's tags.")]
    public static async Task<string> ListDocs([Description("Organisation id")] Guid orgId, AccessService access, InklayerDbContext db, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<DocTreeResponse>(await DocEndpoints.TreeAsync(orgId, access, db, ct)));

    [McpServerTool(Name = "search_docs", ReadOnly = true), Description("Full-text search of an organisation's docs. Every word must match (as a prefix). Matches are marked **like this** in the snippets.")]
    public static async Task<string> SearchDocs(
        [Description("Organisation id")] Guid orgId, [Description("Words to find")] string query, AccessService access, InklayerDbContext db, DocIndexer indexer, CancellationToken ct)
    {
        var results = ToolResults.Value<List<DocSearchResultResponse>>(await DocEndpoints.SearchAsync(orgId, query, access, db, indexer, ct));
        return ToolResults.ToJson(results.Select(r => r with { Snippet = r.Snippet.Replace("\u0002", "**", StringComparison.Ordinal).Replace("\u0003", "**", StringComparison.Ordinal) }));
    }

    [McpServerTool(Name = "read_doc", ReadOnly = true), Description("A doc's current markdown (including edits people are making right now), with its tags, the docs and comments it links, and what links to it.")]
    public static async Task<string> ReadDoc(
        [Description("Doc id")] Guid docId, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocText text, CancellationToken ct)
    {
        var info = ToolResults.Value<DocResponse>(await DocEndpoints.GetAsync(docId, access, currentUser, db, ct));
        var markdown = await text.ReadAsync(docId, ct) ?? throw new McpException("Not found, or you don't have access to it.");
        return ToolResults.ToJson(new
        {
            info.Id, info.OrganizationId, info.Folder, info.Title, info.Tags, info.UpdatedAt, info.UpdatedBy, info.CanEdit,
            Markdown = markdown,
            LinksTo = info.Links, LinksToComments = info.CommentLinks,
            LinkedFrom = info.Backlinks.Select(d => new { d.Id, d.Folder, d.Title }),
            LinkedFromComments = info.CommentBacklinks,
        });
    }

    [McpServerTool(Name = "doc_history", ReadOnly = true), Description("Who created, edited, renamed, moved or deleted a doc, and when.")]
    public static async Task<string> DocHistory([Description("Doc id")] Guid docId, AccessService access, InklayerDbContext db, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<object>(await DocEndpoints.HistoryAsync(docId, access, db, ct)));

    [McpServerTool(Name = "list_tags", ReadOnly = true), Description("The #tags used in an organisation's docs, with how many docs have each.")]
    public static async Task<string> ListTags([Description("Organisation id")] Guid orgId, AccessService access, InklayerDbContext db, CancellationToken ct) =>
        ToolResults.ToJson(ToolResults.Value<object>(await DocEndpoints.TagsAsync(orgId, access, db, ct)));

    [McpServerTool(Name = "recent_activity", ReadOnly = true), Description("Recent activity the person can see, newest first: comments and replies, docs, and (for admins) sign-ins and errors.")]
    public static async Task<string> RecentActivity(
        CurrentUser currentUser, InklayerDbContext db, FeatureSwitches features, CancellationToken ct,
        [Description("Only one kind: comments, docs, signins or errors")] string? kind = null, [Description("How many, at most 100 (default 30)")] int? limit = null) =>
        ToolResults.ToJson(ToolResults.Value<ActivityResponse>(await ActivityEndpoints.ListAsync(kind, null, null, Math.Clamp(limit ?? 30, 1, 100), currentUser, db, features, ct)).Items);

    /* ------------------------------------------------------------------ docs: changing */

    [McpServerTool(Name = "create_doc", OpenWorld = false), Description("Create a doc in an organisation, optionally with markdown. Titles are unique per folder and can't contain [ ] | # / \\ or ^.")]
    public static async Task<string> CreateDoc(
        [Description("Organisation id")] Guid orgId, [Description("Title")] string title,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, DocText text, TimeProvider clock, CancellationToken ct,
        [Description("Folder path, e.g. Research/Interviews; empty for the top level")] string? folder = null, [Description("Markdown to start with")] string? content = null)
    {
        var created = ToolResults.Value<DocSummaryResponse>(await DocEndpoints.CreateAsync(orgId, new CreateDocRequest(folder, title), access, currentUser, db, indexer, clock, ct));
        if (!string.IsNullOrEmpty(content))
        {
            await text.EditAsync(created.Id, currentUser.Id!.Value, before => [new TextEdit(0, before.Length, content)], ct);
        }

        return ToolResults.ToJson(created);
    }

    [McpServerTool(Name = "edit_doc", OpenWorld = false), Description(
        "Change a doc's markdown. Modes: replace_text swaps `find` (which must appear exactly once) for `text`; append adds `text` " +
        "at the end on a new line; replace_all replaces the whole doc with `text`. Read the doc first. People editing it see the change live.")]
    public static async Task<string> EditDoc(
        [Description("Doc id")] Guid docId, [Description("replace_text, append or replace_all")] string mode, [Description("The new text")] string text,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, DocText docText, CancellationToken ct,
        [Description("For replace_text: the exact text to replace")] string? find = null)
    {
        await RequireEditAsync(docId, access, db, ct);
        var result = await docText.EditAsync(docId, currentUser.Id!.Value, before => mode switch
        {
            "replace_all" => [Minimal(before, text)],
            "append" => [new TextEdit(before.Length, 0, (before.Length == 0 || before.EndsWith('\n') ? "" : "\n") + text)],
            "replace_text" => [ReplaceOnce(before, find, text)],
            _ => throw new McpException("mode must be replace_text, append or replace_all."),
        }, ct) ?? throw new McpException("Not found, or you don't have access to it.");
        return $"Saved. The doc is now {result.Length} characters.";
    }

    [McpServerTool(Name = "rename_or_move_doc", OpenWorld = false), Description("Rename a doc and/or move it to another folder. [[Links]] to it in other docs and in comments are updated.")]
    public static async Task<string> RenameOrMoveDoc(
        [Description("Doc id")] Guid docId,
        AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, DocText docText, TimeProvider clock, CancellationToken ct,
        [Description("New title (omit to keep)")] string? title = null, [Description("New folder path (omit to keep; empty for the top level)")] string? folder = null)
    {
        var before = await db.Docs.AsNoTracking().Where(d => d.Id == docId && d.DeletedAt == null).Select(d => new { d.Version, d.Folder, d.Title, d.PathKey, d.TitleKey }).SingleOrDefaultAsync(ct)
            ?? throw new McpException("Not found, or you don't have access to it.");
        var changed = ToolResults.Value<DocChangedResponse>(
            await DocEndpoints.UpdateAsync(docId, new UpdateDocRequest(before.Version, title, folder), access, currentUser, db, indexer, clock, ct));

        // Other docs that linked the old name: rewrite their links (comments were rewritten by the update itself).
        var after = changed.Doc;
        foreach (var linking in changed.RelinkDocs)
        {
            await docText.EditAsync(linking, currentUser.Id!.Value, current =>
            {
                var rewritten = DocMarkdown.RewriteLinks(current, link => link.Key!.Contains('/', StringComparison.Ordinal)
                    ? link.Key == before.PathKey ? (after.Folder.Length > 0 ? $"{after.Folder}/{after.Title}" : after.Title) : null
                    : link.Key == before.TitleKey && !string.Equals(before.Title, after.Title, StringComparison.Ordinal) ? after.Title : null);
                return rewritten == current ? [] : [Minimal(current, rewritten)];
            }, ct);
        }

        return ToolResults.ToJson(new { after.Id, after.Folder, after.Title, UpdatedLinksIn = changed.RelinkDocs.Count });
    }

    [McpServerTool(Name = "delete_doc", Destructive = true, OpenWorld = false), Description("Delete a doc. Links to it show as missing; its history is kept.")]
    public static async Task<string> DeleteDoc(
        [Description("Doc id")] Guid docId, AccessService access, CurrentUser currentUser, InklayerDbContext db, DocIndexer indexer, TimeProvider clock, CancellationToken ct)
    {
        var version = await db.Docs.Where(d => d.Id == docId && d.DeletedAt == null).Select(d => (int?)d.Version).SingleOrDefaultAsync(ct)
            ?? throw new McpException("Not found, or you don't have access to it.");
        ToolResults.Ok(await DocEndpoints.DeleteAsync(docId, version, access, currentUser, db, indexer, clock, ct));
        return "Deleted.";
    }

    /* ------------------------------------------------------------------ helpers */

    /// <summary>Tools that work on docs: hidden and refused while docs are turned off.</summary>
    public static readonly HashSet<string> DocTools = new(StringComparer.Ordinal)
    {
        "list_docs", "search_docs", "read_doc", "doc_history", "list_tags", "create_doc", "edit_doc", "rename_or_move_doc", "delete_doc",
    };

    private static object Summary(AnnotationResponse a) => new
    {
        a.Id, a.ProjectId, a.PageUrl, a.Kind, a.Status, a.Body, Author = a.Author.DisplayName, AuthorFullName = a.Author.FullName, AuthorRole = a.Author.Role,
        a.CreatedAt, a.CanEdit,
        Replies = a.Replies?.Select(r => new { r.Id, Author = r.Author.DisplayName, AuthorFullName = r.Author.FullName, r.Body, r.CreatedAt, r.CanDelete }),
        DocLinks = a.DocLinks, MentionedIn = a.MentionedIn,
        a.HasScreenshot,
        Context = a.Context is { } c ? new
        {
            c.Browser, c.Os, Viewport = $"{c.ViewportWidth}×{c.ViewportHeight} @{c.DevicePixelRatio}x", c.Selector, c.ElementHtml,
            ConsoleErrors = c.Console, FailedRequests = c.Network,
        } : null,
    };

    private static async Task<int> VersionOfCommentAsync(InklayerDbContext db, Guid commentId, CancellationToken ct) =>
        await db.Annotations.Where(a => a.Id == commentId && a.DeletedAt == null).Select(a => (int?)a.Version).SingleOrDefaultAsync(ct)
            ?? throw new McpException("Not found, or you don't have access to it.");

    /// <summary>Editing a doc's text needs Commenter or above in its organisation, as in the app.</summary>
    private static async Task RequireEditAsync(Guid docId, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var orgId = await db.Docs.Where(d => d.Id == docId && d.DeletedAt == null).Select(d => (Guid?)d.OrganizationId).SingleOrDefaultAsync(ct);
        var check = orgId is null ? AccessResult.NotFound() : await access.CheckOrganizationAsync(orgId.Value, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            ToolResults.Ok(check.Denied!);
        }
    }

    private static TextEdit ReplaceOnce(string text, string? find, string replacement)
    {
        if (string.IsNullOrEmpty(find))
        {
            throw new McpException("replace_text needs `find`: the exact text to replace.");
        }

        var first = text.IndexOf(find, StringComparison.Ordinal);
        if (first < 0)
        {
            throw new McpException("`find` isn't in the doc. Read it again: someone may have just changed it.");
        }

        if (text.IndexOf(find, first + 1, StringComparison.Ordinal) >= 0)
        {
            throw new McpException("`find` appears more than once. Include more of the surrounding text so it's unique.");
        }

        return new TextEdit(first, find.Length, replacement);
    }

    /// <summary>
    /// The smallest single edit that turns <paramref name="before"/> into <paramref name="after"/>: only the changed middle is
    /// replaced, so people editing elsewhere in the doc keep their place.
    /// </summary>
    internal static TextEdit Minimal(string before, string after)
    {
        var prefix = 0;
        while (prefix < before.Length && prefix < after.Length && before[prefix] == after[prefix])
        {
            prefix++;
        }

        var suffix = 0;
        while (suffix < before.Length - prefix && suffix < after.Length - prefix && before[^(suffix + 1)] == after[^(suffix + 1)])
        {
            suffix++;
        }

        // Don't split a surrogate pair (an emoji) in two.
        if (prefix > 0 && char.IsHighSurrogate(before[prefix - 1]))
        {
            prefix--;
        }

        if (suffix > 0 && char.IsLowSurrogate(before[^suffix]))
        {
            suffix--;
        }

        return new TextEdit(prefix, before.Length - prefix - suffix, after[prefix..^suffix]);
    }
}
