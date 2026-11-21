using Inklayer.Api.Access;
using Inklayer.Api.Features.Issues;
using Inklayer.Domain.Annotations;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Live;

/// <summary>A comment linked to a pull request, as shown on the pull request's page.</summary>
public sealed record PullRequestCommentResponse(
    Guid Id, Guid ProjectId, string ProjectName, string PageUrl, string Body, AnnotationStatus Status, string AuthorName, DateTime CreatedAt,
    IReadOnlyList<IssueResponse> Issues);

/// <summary>A pull request with Inklayer comments linked to it, and those comments.</summary>
public sealed record PullRequestPageResponse(string Url, string Key, string Kind, string State, IReadOnlyList<PullRequestCommentResponse> Comments);

/// <summary>
/// Pull requests' pages, for the extension: <c>/api/live/pull-requests</c> lists the addresses of pull requests with
/// comments the caller can see, which the extension matches locally (so it only asks about pages that are one), and
/// <c>/api/live/pull-request?url=</c> gives one's comments.
/// </summary>
internal static class LivePullRequests
{
    private const int MaxPullRequests = 2000;

    public static void Map(RouteGroupBuilder live)
    {
        live.MapGet("/pull-requests", ListAsync).Produces<List<string>>()
            .WithSummary("Addresses of pull requests linked to comments the caller can see");
        live.MapGet("/pull-request", GetAsync).Produces<PullRequestPageResponse>()
            .WithSummary("The comments linked to a pull request: ?url=<the pull request's address, from /pull-requests>");
    }

    private static async Task<IResult> ListAsync(CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await LiveEndpoints.VisibleProjectsAsync(currentUser, db, ct) is not { } visible)
        {
            return TypedResults.Unauthorized();
        }

        var ids = visible.Select(v => v.Project.Id).ToList();
        var urls = await (from i in db.AnnotationIssues.AsNoTracking()
                          where i.PullRequest
                          join a in db.Annotations.AsNoTracking() on i.AnnotationId equals a.Id
                          where ids.Contains(a.ProjectId) && a.DeletedAt == null
                          orderby i.CreatedAt descending
                          select i.Url).Distinct().Take(MaxPullRequests).ToListAsync(ct);
        return TypedResults.Ok(urls);
    }

    private static async Task<IResult> GetAsync(string? url, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await LiveEndpoints.VisibleProjectsAsync(currentUser, db, ct) is not { } visible)
        {
            return TypedResults.Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(url) || url.Length > 2000)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["url"] = ["Give the pull request's address."] });
        }

        var projects = visible.ToDictionary(v => v.Project.Id, v => v.Project.Name);
        var ids = projects.Keys.ToList();
        var rows = await (from i in db.AnnotationIssues.AsNoTracking()
                          where i.PullRequest && i.Url == url
                          join c in db.IssueTrackerConnections.AsNoTracking() on i.ConnectionId equals c.Id
                          join a in db.Annotations.AsNoTracking() on i.AnnotationId equals a.Id
                          where ids.Contains(a.ProjectId) && a.DeletedAt == null
                          orderby a.CreatedAt
                          select new { Link = i, c.Kind, Comment = a }).ToListAsync(ct);
        if (rows.Count == 0)
        {
            return TypedResults.NotFound();
        }

        var commentIds = rows.Select(r => r.Comment.Id).Distinct().ToList();
        var issues = await IssueService.ForAsync(db, commentIds, ct);
        var authorIds = rows.Select(r => r.Comment.AuthorUserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => authorIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var first = rows[0];
        var comments = rows.DistinctBy(r => r.Comment.Id).Select(r => new PullRequestCommentResponse(
            r.Comment.Id, r.Comment.ProjectId, projects[r.Comment.ProjectId], r.Comment.PageUrl,
            r.Comment.Body.Length > 500 ? r.Comment.Body[..499] + "…" : r.Comment.Body, r.Comment.Status,
            names.GetValueOrDefault(r.Comment.AuthorUserId, "Someone"), r.Comment.CreatedAt,
            [.. issues.GetValueOrDefault(r.Comment.Id, []).Where(i => !i.PullRequest)])).ToList();
        return TypedResults.Ok(new PullRequestPageResponse(first.Link.Url, first.Link.Key, first.Kind, first.Link.State, comments));
    }
}
