using System.Text;
using System.Text.Json;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Annotations;
using Inklayer.Api.Features.Notifications;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Inklayer.Domain.Notifications;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

public sealed record IssueResponse(Guid Id, string Kind, string Key, string Url, string State);

/// <summary>Issues made from comments: creating them with everything a developer needs, and closing them when comments are resolved.</summary>
internal sealed class IssueService(
    InklayerDbContext db, Trackers trackers, IntegrationSecrets secrets, NotificationService notifications, IHttpContextAccessor http, IConfiguration configuration,
    FeatureSwitches features, TimeProvider clock)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static TrackerSettings SettingsOf(IssueTrackerConnection c) => JsonSerializer.Deserialize<TrackerSettings>(c.Settings, Json)!;

    public static string SettingsJson(TrackerSettings s) => JsonSerializer.Serialize(s, Json);

    public async Task<AnnotationIssue> CreateAsync(Annotation comment, IssueTrackerConnection connection, string? title, Guid actorUserId, CancellationToken ct)
    {
        var markdown = await IssueBodyAsync(comment, ct);
        var plainBody = markdown.Split('\n')[0];
        var issueTitle = (title?.Trim() is { Length: > 0 } t ? t : plainBody.Length > 0 ? plainBody : $"Comment on {Shorten(comment.PageUrl)}");
        issueTitle = issueTitle.Length > 120 ? issueTitle[..119] + "…" : issueTitle;

        var created = await trackers.For(connection.Kind).CreateAsync(SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), issueTitle, markdown, ct);
        var now = clock.GetUtcNow().UtcDateTime;
        var issue = new AnnotationIssue
        {
            AnnotationId = comment.Id, ConnectionId = connection.Id, ExternalId = created.ExternalId, Key = created.Key, Url = created.Url,
            CreatedByUserId = actorUserId, CreatedAt = now, LastSyncedAt = now,
        };
        db.AnnotationIssues.Add(issue);
        await db.SaveChangesAsync(ct);
        await notifications.IssueCreatedAsync(comment, actorUserId, $"{TrackerKinds.Name(connection.Kind)} {issue.Key}", issue.Url, ct);
        return issue;
    }

    /// <summary>The comment was resolved in Inklayer: close its open issues where the connection says to. Failures are noted on the connection.</summary>
    public async Task CommentResolvedAsync(Annotation comment, CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.IssueTrackers, ct))
        {
            return;
        }

        var open = await db.AnnotationIssues.Where(i => i.AnnotationId == comment.Id && i.State == IssueStates.Open).ToListAsync(ct);
        foreach (var issue in open)
        {
            var connection = await db.IssueTrackerConnections.SingleOrDefaultAsync(c => c.Id == issue.ConnectionId, ct);
            if (connection is not { CloseIssueOnResolve: true })
            {
                continue;
            }

            try
            {
                await trackers.For(connection.Kind).CloseAsync(SettingsOf(connection), secrets.Unprotect(connection.ProtectedToken), issue.ExternalId, ct);
                issue.State = IssueStates.Closed;
                issue.LastSyncedAt = clock.GetUtcNow().UtcDateTime;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                connection.LastError = Clip($"Closing {issue.Key}: {ex.Message}");
                connection.LastErrorAt = clock.GetUtcNow().UtcDateTime;
            }
        }

        await db.SaveChangesAsync(ct);
    }

    public static async Task<Dictionary<Guid, List<IssueResponse>>> ForAsync(InklayerDbContext db, List<Guid> annotationIds, CancellationToken ct)
    {
        var rows = await (from i in db.AnnotationIssues.AsNoTracking()
                          where annotationIds.Contains(i.AnnotationId)
                          join c in db.IssueTrackerConnections on i.ConnectionId equals c.Id
                          orderby i.CreatedAt
                          select new { i.AnnotationId, Issue = new IssueResponse(i.Id, c.Kind, i.Key, i.Url, i.State) }).ToListAsync(ct);
        return rows.GroupBy(r => r.AnnotationId).ToDictionary(g => g.Key, g => g.Select(r => r.Issue).ToList());
    }

    /// <summary>The comment, its replies, where it is, and the page details: what a developer needs to pick it up.</summary>
    private async Task<string> IssueBodyAsync(Annotation comment, CancellationToken ct)
    {
        var replies = await db.AnnotationReplies.AsNoTracking().Where(r => r.AnnotationId == comment.Id && r.DeletedAt == null).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        var people = replies.Select(r => r.AuthorUserId).Append(comment.AuthorUserId).Concat(Mentions.Extract(comment.Body))
            .Concat(replies.SelectMany(r => Mentions.Extract(r.Body))).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var context = await db.AnnotationContexts.AsNoTracking().SingleOrDefaultAsync(c => c.AnnotationId == comment.Id, ct);
        var origin = http.HttpContext is { } h ? McpResource.Origin(h.Request) : (configuration["Inklayer:PublicUrl"] ?? "").TrimEnd('/');

        var body = new StringBuilder();
        body.AppendLine(Mentions.ToNames(comment.Body, names).Trim());
        body.AppendLine();
        body.AppendLine($"**Page:** {comment.PageUrl}");
        body.AppendLine($"**Reported by:** {names.GetValueOrDefault(comment.AuthorUserId, "someone")} in Inklayer: {origin}/comments/{comment.Id}");
        if (replies.Count > 0)
        {
            body.AppendLine();
            body.AppendLine("**Replies:**");
            foreach (var reply in replies)
            {
                body.AppendLine($"- {names.GetValueOrDefault(reply.AuthorUserId, "someone")}: {Mentions.ToNames(reply.Body, names).Replace('\n', ' ')}");
            }
        }

        if (context is not null)
        {
            var c = ContextEndpoints.ToResponse(context);
            body.AppendLine();
            body.AppendLine($"**Browser:** {c.Browser} on {c.Os}, {c.ViewportWidth}×{c.ViewportHeight} @{c.DevicePixelRatio}x");
            if (c.Selector.Length > 0)
            {
                body.AppendLine($"**Element:** `{c.Selector}`");
            }

            foreach (var e in c.Console.Take(10))
            {
                body.AppendLine($"- console.{e.Level}: {e.Message}");
            }

            foreach (var n in c.Network.Take(10))
            {
                body.AppendLine($"- {n.Method} {n.Url} → {(n.Status == 0 ? "failed" : n.Status)}");
            }

            if (await db.AnnotationScreenshots.AnyAsync(s => s.AnnotationId == comment.Id, ct))
            {
                body.AppendLine($"**Screenshot:** {origin}/comments/{comment.Id}");
            }
        }

        return body.ToString().TrimEnd();
    }

    private static string Shorten(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host + u.AbsolutePath : url;

    private static string Clip(string text) => text.Length > 300 ? text[..300] + "…" : text;
}
