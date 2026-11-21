using System.Net;
using Inklayer.Api.Features.Issues;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

/// <summary>How often linked issues are checked: all that are due, old closed ones daily, and the ones on screen soon.</summary>
public sealed partial class IssueTrackerTests
{
    /// <summary>A GitHub repository whose issues are all open with no comments; returns the tracker and comment to link them to.</summary>
    private async Task<(Guid TrackerId, Guid CommentId, Guid AnaId, HttpClient Ana)> SyncRepoAsync(string repo)
    {
        var (admin, projectId, ana, anaMe, viewer) = await ProjectAsync();
        admin.Dispose();
        viewer.Dispose();
        var url = $"https://api.github.com/repos/acme/{repo}";
        factory.Outbound.Responders[url] = (_, _) => Json(new { has_issues = true, permissions = new { push = true } });
        factory.Outbound.Responders[$"{url}/issues/"] = (request, _) => request.RequestUri!.AbsolutePath.EndsWith("/comments", StringComparison.Ordinal)
            ? Json(Array.Empty<object>())
            : Json(new { number = 1, title = "x", html_url = "https://github.com/x", state = "open" });
        using var adminAgain = await factory.SignInAsAdminAsync();
        using var connected = await adminAgain.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "github", token = "ghp", settings = new { owner = "acme", repo } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        return (tracker.Id, await CommentAsync(ana, projectId, $"Linked to {repo}"), anaMe.Id, ana);
    }

    private async Task LinkRowsAsync(Guid trackerId, Guid commentId, Guid by, params (int Number, string State, DateTime? ClosedAt, DateTime LastSynced)[] issues)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        foreach (var (number, state, closedAt, lastSynced) in issues)
        {
            db.AnnotationIssues.Add(new AnnotationIssue
            {
                AnnotationId = commentId, ConnectionId = trackerId, ExternalId = $"{number}", Key = $"#{number}", Url = $"https://github.com/x/{number}",
                State = state, ClosedAt = closedAt, CreatedByUserId = by, CreatedAt = DateTime.UtcNow, LastSyncedAt = lastSynced, CommentsCheckedAt = lastSynced,
            });
        }

        await db.SaveChangesAsync();
    }

    /// <summary>Which of the repository's issues were asked about.</summary>
    private HashSet<int> Checked(string repo) =>
    [
        .. factory.Outbound.To($"https://api.github.com/repos/acme/{repo}/issues/")
            .Select(r => r.Request.RequestUri!.AbsolutePath.Split('/'))
            .Where(parts => parts.Length == 6)
            .Select(parts => int.Parse(parts[5], System.Globalization.CultureInfo.InvariantCulture)),
    ];

    [Fact]
    public async Task Every_due_issue_is_checked_in_one_round_and_long_closed_ones_only_daily()
    {
        var (trackerId, commentId, anaId, ana) = await SyncRepoAsync("sync-round");
        using var _ = ana;
        var now = DateTime.UtcNow;
        // More than one batch of open issues, all due.
        await LinkRowsAsync(trackerId, commentId, anaId, [.. Enumerable.Range(1, 70).Select(n => (n, IssueStates.Open, (DateTime?)null, DateTime.UnixEpoch))]);
        await LinkRowsAsync(trackerId, commentId, anaId,
            (101, IssueStates.Closed, now.AddDays(-20), now.AddMinutes(-10)), // closed long ago, checked 10 minutes ago: not yet
            (102, IssueStates.Closed, now.AddDays(-20), now.AddDays(-2)), // closed long ago, not checked for 2 days: due
            (103, IssueStates.Closed, now.AddDays(-3), now.AddMinutes(-10))); // closed lately: every 5 minutes

        await factory.Services.GetRequiredService<IssueSyncService>().RunOnceAsync(CancellationToken.None);

        var asked = Checked("sync-round");
        Assert.True(Enumerable.Range(1, 70).All(asked.Contains), $"Not checked: {string.Join(", ", Enumerable.Range(1, 70).Where(n => !asked.Contains(n)))}");
        Assert.DoesNotContain(101, asked);
        Assert.Contains(102, asked);
        Assert.Contains(103, asked);
    }

    [Fact]
    public async Task Issues_of_comments_someone_is_looking_at_are_checked_soon_but_not_more_than_once_a_minute()
    {
        var (trackerId, commentId, anaId, ana) = await SyncRepoAsync("sync-wanted");
        using var _ = ana;
        // Checked 2 minutes ago: not due in the 5-minute round.
        await LinkRowsAsync(trackerId, commentId, anaId, (7, IssueStates.Open, null, DateTime.UtcNow.AddMinutes(-2)));
        var sync = factory.Services.GetRequiredService<IssueSyncService>();
        await sync.RunOnceAsync(CancellationToken.None);
        Assert.DoesNotContain(7, Checked("sync-wanted"));

        // The page is open in the extension: checked on the next quick pass.
        await ana.GetAsync(new Uri("/api/live/annotations?url=https%3A%2F%2Fshop.example%2Fcheckout", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
        await sync.RunWantedAsync(CancellationToken.None);
        Assert.Contains(7, Checked("sync-wanted"));
        var asked = factory.Outbound.To("https://api.github.com/repos/acme/sync-wanted/issues/7").Count();

        // Looked at again straight away, as the comment page: not asked again within the minute.
        await ana.GetAsync(new Uri($"/api/annotations/{commentId}", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
        await sync.RunWantedAsync(CancellationToken.None);
        Assert.Equal(asked, factory.Outbound.To("https://api.github.com/repos/acme/sync-wanted/issues/7").Count());
    }
}
