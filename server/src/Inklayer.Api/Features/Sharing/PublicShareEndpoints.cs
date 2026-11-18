using Inklayer.Api.Features.Docs;
using Inklayer.Api.Features.Notifications;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Notifications;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Sharing;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Sharing;

public sealed record PublicShareResponse(string Kind, string Title, DateTime? ExpiresAt, IReadOnlyList<PublicPageResponse>? Pages, PublicDocResponse? Doc);

public sealed record PublicPageResponse(string PageUrl, IReadOnlyList<PublicCommentResponse> Comments);

/// <summary>A comment as guests see it: shown names only, no emails, no page details besides the screenshot.</summary>
public sealed record PublicCommentResponse(Guid Id, string Body, string Status, string Author, DateTime CreatedAt, bool HasScreenshot, IReadOnlyList<PublicReplyResponse> Replies);

public sealed record PublicReplyResponse(string Author, string Body, DateTime CreatedAt);

/// <param name="Links">Docs this one links to that are public too, by their lowercase link target, with their link token.</param>
public sealed record PublicDocResponse(string Markdown, DateTime UpdatedAt, IReadOnlyList<PublicDocLinkResponse> Links);

public sealed record PublicDocLinkResponse(string Key, string Token);

/// <summary>
/// What a share link shows, to anyone with the link, signed in or not and from any network (while sharing is on).
/// Rate limited per address; nothing here is indexed by search engines or sends a referrer.
/// </summary>
internal static class PublicShareEndpoints
{
    public const string RateLimitPolicy = "public";
    private const int MaxComments = 500;

    public static IEndpointRouteBuilder MapPublicShareEndpoints(this IEndpointRouteBuilder app)
    {
        var shares = app.MapGroup("/api/public/shares").WithTags("Sharing").AllowAnonymous().RequireRateLimiting(RateLimitPolicy);
        shares.MapGet("/{token}", GetAsync).WithSummary("A shared page, project or doc, read-only");
        shares.MapGet("/{token}/screenshots/{commentId:guid}", ScreenshotAsync).WithSummary("A shared comment's screenshot");
        return app;
    }

    private static async Task<ShareLink?> FindAsync(InklayerDbContext db, string token, DateTime now, CancellationToken ct)
    {
        if (token.Length is < 20 or > 100)
        {
            return null;
        }

        var hash = ShareEndpoints.Hash(token);
        var share = await db.ShareLinks.AsNoTracking().SingleOrDefaultAsync(s => s.TokenHash == hash, ct);
        return share is not null && share.IsActive(now) ? share : null;
    }

    private static IQueryable<Annotation> CommentsOf(InklayerDbContext db, ShareLink share)
    {
        var query = db.Annotations.AsNoTracking().Where(a => a.ProjectId == share.ProjectId && a.DeletedAt == null && a.Body != "");
        if (!share.IncludeResolved)
        {
            query = query.Where(a => a.Status == AnnotationStatus.Open);
        }

        if (share.Kind == ShareKinds.Page)
        {
            var keys = LivePageUrl.Candidates(share.PageUrl);
            query = query.Where(a => keys.Contains(a.PageUrl));
        }

        return query;
    }

    private static async Task<IResult> GetAsync(
        string token, HttpContext http, InklayerDbContext db, DocText text, FeatureSwitches features, TimeProvider clock, CancellationToken ct)
    {
        var now = clock.GetUtcNow().UtcDateTime;
        var share = await FindAsync(db, token, now, ct);
        if (share is null)
        {
            return Gone();
        }

        await db.ShareLinks.Where(s => s.Id == share.Id).ExecuteUpdateAsync(u => u.SetProperty(s => s.ViewCount, s => s.ViewCount + 1).SetProperty(s => s.LastViewedAt, now), ct);

        if (share.Kind == ShareKinds.Doc)
        {
            if (!await features.IsEnabledAsync(Feature.Docs, ct))
            {
                return Gone();
            }

            var doc = await db.Docs.AsNoTracking().SingleOrDefaultAsync(d => d.Id == share.DocId && d.DeletedAt == null, ct);
            if (doc is null)
            {
                return Gone();
            }

            var markdown = await text.ReadAsync(doc.Id, ct) ?? doc.Content;
            var mentioned = Mentions.Extract(markdown).ToList();
            var names = await db.Users.AsNoTracking().Where(u => mentioned.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);

            // [[Links]] to docs that are public too lead to their own links.
            var links = await (from l in db.DocLinks.AsNoTracking()
                               where l.SourceDocId == doc.Id && l.TargetDocId != null
                               join s in db.ShareLinks.AsNoTracking() on l.TargetDocId equals s.DocId
                               where s.RevokedAt == null && (s.ExpiresAt == null || s.ExpiresAt > now)
                               select new { l.TargetKey, s.ProtectedToken }).ToListAsync(ct);
            var secrets = http.RequestServices.GetRequiredService<IntegrationSecrets>();
            return TypedResults.Ok(new PublicShareResponse(share.Kind, doc.Title, share.ExpiresAt, null,
                new PublicDocResponse(Mentions.ToNames(markdown, names), doc.UpdatedAt,
                    [.. links.DistinctBy(l => l.TargetKey).Select(l => new PublicDocLinkResponse(l.TargetKey, secrets.Unprotect(l.ProtectedToken)))])));
        }

        var projectName = await db.Projects.AsNoTracking().Where(p => p.Id == share.ProjectId).Select(p => p.Name).SingleOrDefaultAsync(ct);
        if (projectName is null)
        {
            return Gone();
        }

        var comments = await CommentsOf(db, share).OrderBy(a => a.CreatedAt).Take(MaxComments).ToListAsync(ct);
        var ids = comments.Select(c => c.Id).ToList();
        var replies = await db.AnnotationReplies.AsNoTracking().Where(r => ids.Contains(r.AnnotationId) && r.DeletedAt == null).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        var people = comments.Select(c => c.AuthorUserId).Concat(replies.Select(r => r.AuthorUserId))
            .Concat(comments.SelectMany(c => Mentions.Extract(c.Body))).Concat(replies.SelectMany(r => Mentions.Extract(r.Body))).Distinct().ToList();
        var shown = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var screenshots = await features.IsEnabledAsync(Feature.BugContext, ct)
            ? (await db.AnnotationScreenshots.AsNoTracking().Where(s => ids.Contains(s.AnnotationId)).Select(s => s.AnnotationId).ToListAsync(ct)).ToHashSet()
            : [];
        var repliesOf = replies.ToLookup(r => r.AnnotationId);

        var pages = comments.GroupBy(c => c.PageUrl).Select(g => new PublicPageResponse(g.Key, [.. g.Select(c => new PublicCommentResponse(
            c.Id, Mentions.ToNames(c.Body, shown), c.Status.ToString(), shown.GetValueOrDefault(c.AuthorUserId, "Someone"), c.CreatedAt, screenshots.Contains(c.Id),
            [.. repliesOf[c.Id].Select(r => new PublicReplyResponse(shown.GetValueOrDefault(r.AuthorUserId, "Someone"), Mentions.ToNames(r.Body, shown), r.CreatedAt))]))])).ToList();
        return TypedResults.Ok(new PublicShareResponse(share.Kind, projectName, share.ExpiresAt, pages, null));
    }

    private static async Task<IResult> ScreenshotAsync(
        string token, Guid commentId, InklayerDbContext db, FeatureSwitches features, TimeProvider clock, HttpContext http, CancellationToken ct)
    {
        var share = await FindAsync(db, token, clock.GetUtcNow().UtcDateTime, ct);
        if (share is null || share.Kind == ShareKinds.Doc || !await features.IsEnabledAsync(Feature.BugContext, ct)
            || !await CommentsOf(db, share).AnyAsync(a => a.Id == commentId, ct))
        {
            return TypedResults.NotFound();
        }

        var screenshot = await db.AnnotationScreenshots.AsNoTracking().SingleOrDefaultAsync(s => s.AnnotationId == commentId, ct);
        if (screenshot is null)
        {
            return TypedResults.NotFound();
        }

        http.Response.Headers.CacheControl = "private, max-age=300";
        return TypedResults.File(screenshot.Bytes, screenshot.ContentType);
    }

    private static IResult Gone() =>
        TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: "This link doesn't work any more.", detail: "It may have been turned off or expired. Ask whoever sent it for a new one.");
}
