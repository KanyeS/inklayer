using System.ComponentModel.DataAnnotations;
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

/// <param name="PullRequest">A pull request (GitLab: merge request) rather than an issue; it can be merged.</param>
public sealed record IssueResponse(
    Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind, string Key, string Url,
    [property: AllowedValues(IssueStates.Open, IssueStates.Closed, IssueStates.Merged)] string State, bool PullRequest = false);

/// <summary>A comment on a linked issue, written in the tracker, shown in the Inklayer thread.</summary>
public sealed record IssueCommentResponse(
    Guid Id, [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind,
    string IssueKey, string IssueUrl, string AuthorName, string? AuthorUrl, string Body, DateTime CreatedAt, DateTime UpdatedAt);

/// <summary>The issue to create a new one under couldn't be found: the request's fault, not the tracker's.</summary>
internal sealed class IssueParentException(string message) : InvalidOperationException(message);

/// <summary>Issues made from comments: creating them with everything a developer needs, and closing them when comments are resolved.</summary>
internal sealed partial class IssueService(
    InklayerDbContext db, Trackers trackers, TrackerAccounts accounts, NotificationService notifications, IHttpContextAccessor http, IConfiguration configuration,
    FeatureSwitches features, TimeProvider clock, Media.IMediaStore mediaStore)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static TrackerSettings SettingsOf(IssueTrackerConnection c) => JsonSerializer.Deserialize<TrackerSettings>(c.Settings, Json)!;

    public static string SettingsJson(TrackerSettings s) => JsonSerializer.Serialize(s, Json);

    /// <param name="parent">Create it under this issue (its address, number or key): a Jira sub-task, an Azure DevOps child work item.</param>
    /// <param name="type">The issue type, instead of the connection's (Jira, Azure DevOps); must be one the project has.</param>
    public async Task<AnnotationIssue> CreateAsync(
        Annotation comment, IssueTrackerConnection connection, string? title, Guid actorUserId, CancellationToken ct, string? parent = null, string? type = null)
    {
        var token = await accounts.RequireForUserAsync(connection, actorUserId, ct);
        var tracker = trackers.For(connection.Kind);
        var settings = SettingsOf(connection);
        if (type?.Trim() is { Length: > 0 } wanted)
        {
            if (tracker is not IIssueTypes typed)
            {
                throw new InvalidOperationException($"{TrackerKinds.Name(connection.Kind)} issues don't have types to choose from.");
            }

            // Only a type the project offers, spelled as the tracker spells it.
            var types = await accounts.WithAsync(token, t => typed.IssueTypesAsync(settings, t, ct), ct);
            settings = settings with
            {
                IssueType = types.FirstOrDefault(x => string.Equals(x, wanted, StringComparison.OrdinalIgnoreCase))
                    ?? throw new InvalidOperationException($"The project has no issue type called {wanted}."),
            };
        }

        var parentReference = parent?.Trim() is { Length: > 0 } p ? p : null;
        if (parentReference is not null && tracker is not IChildIssues)
        {
            throw new InvalidOperationException($"{TrackerKinds.Name(connection.Kind)} issues can't be created under another issue here.");
        }

        // Checked before the files go anywhere, so a bad parent uploads nothing.
        var parentId = parentReference is null ? null : await accounts.WithAsync(token, t => ParentAsync(tracker, settings, t, parentReference, ct), ct);
        var (fileLines, later) = await PlaceFilesAsync(connection, tracker, settings, token, comment, ct);
        var markdown = await IssueBodyAsync(comment, ct, fileLines);
        var plainBody = markdown.Split('\n')[0];
        var issueTitle = (title?.Trim() is { Length: > 0 } t ? t : plainBody.Length > 0 ? plainBody : $"Comment on {Shorten(comment.PageUrl)}");
        issueTitle = issueTitle.Length > 120 ? issueTitle[..119] + "…" : issueTitle;

        var created = await accounts.WithAsync(token, async t => parentId is null
            ? await tracker.CreateAsync(settings, t, issueTitle, markdown, ct)
            : await ((IChildIssues)tracker).CreateUnderAsync(settings, t, issueTitle, markdown, parentId, ct), ct);
        await AttachLaterAsync(connection, tracker, settings, token, created.ExternalId, created.Key, later, ct);
        var now = clock.GetUtcNow().UtcDateTime;
        var issue = new AnnotationIssue
        {
            AnnotationId = comment.Id, ConnectionId = connection.Id, ExternalId = created.ExternalId, Key = created.Key, Url = created.Url, Title = Clip(issueTitle),
            CreatedByUserId = actorUserId, CreatedAt = now, LastSyncedAt = now, CommentsCheckedAt = now,
        };
        db.AnnotationIssues.Add(issue);
        await db.SaveChangesAsync(ct);
        await notifications.IssueCreatedAsync(comment, actorUserId, $"{TrackerKinds.Name(connection.Kind)} {issue.Key}", issue.Url, ct);
        return issue;
    }

    /// <summary>The parent an issue is to be created under; <see cref="IssueParentException"/> when it can't be found.</summary>
    private static async Task<string> ParentAsync(IIssueTracker tracker, TrackerSettings settings, TrackerAuth token, string reference, CancellationToken ct)
    {
        try
        {
            return (await tracker.GetAsync(settings, token, reference, ct)).ExternalId;
        }
        catch (InvalidOperationException ex)
        {
            throw new IssueParentException($"Couldn't find the parent: {ex.Message}");
        }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            throw new IssueParentException($"Couldn't find the parent {reference}: it doesn't exist, or you can't see it.");
        }
    }

    /// <summary>Looks up the issue a pasted address or number points to, as the person asking.</summary>
    public async Task<FoundIssue> FindAsync(IssueTrackerConnection connection, string reference, Guid actorUserId, CancellationToken ct, bool pullRequest = false)
    {
        var token = await accounts.RequireForUserAsync(connection, actorUserId, ct);
        return pullRequest
            ? AsPullRequest(await accounts.WithAsync(token, t => PullRequestsOf(connection).GetPullRequestAsync(SettingsOf(connection), t, reference, ct), ct))
            : await accounts.WithAsync(token, t => trackers.For(connection.Kind).GetAsync(SettingsOf(connection), t, reference, ct), ct);
    }

    /// <summary>
    /// The types the person can create issues as in the connection's project, asked as them; empty for trackers without
    /// types. <c>Suggested</c>: the connection's own type where the project has it, else Bug, Issue or Task, else the first.
    /// </summary>
    public async Task<(IReadOnlyList<string> Types, string? Suggested)> IssueTypesAsync(IssueTrackerConnection connection, Guid actorUserId, CancellationToken ct)
    {
        if (trackers.For(connection.Kind) is not IIssueTypes typed)
        {
            return ([], null);
        }

        var token = await accounts.RequireForUserAsync(connection, actorUserId, ct);
        var settings = SettingsOf(connection);
        var types = await accounts.WithAsync(token, t => typed.IssueTypesAsync(settings, t, ct), ct);
        return (types, SuggestedType(types, settings.IssueType));
    }

    public static string? SuggestedType(IReadOnlyList<string> types, string? current)
    {
        string? Has(string? name) => types.FirstOrDefault(x => string.Equals(x, name?.Trim(), StringComparison.OrdinalIgnoreCase));
        return Has(current) ?? Has("Bug") ?? Has("Issue") ?? Has("Task") ?? (types.Count > 0 ? types[0] : null);
    }

    public async Task<IReadOnlyList<FoundIssue>> SearchAsync(IssueTrackerConnection connection, string query, Guid actorUserId, CancellationToken ct, bool pullRequests = false)
    {
        var token = await accounts.RequireForUserAsync(connection, actorUserId, ct);
        return pullRequests
            ? [.. (await accounts.WithAsync(token, t => PullRequestsOf(connection).SearchPullRequestsAsync(SettingsOf(connection), t, query, ct), ct)).Select(AsPullRequest)]
            : await accounts.WithAsync(token, t => trackers.For(connection.Kind).SearchAsync(SettingsOf(connection), t, query, ct), ct);
    }

    /// <summary>
    /// Links an issue that already exists to the comment. With <paramref name="addComment"/>, posts the comment (with its
    /// replies, page and details) on the issue first, so the issue has the context. Brings in the issue's comments so far.
    /// </summary>
    public async Task<AnnotationIssue> LinkAsync(
        Annotation comment, IssueTrackerConnection connection, FoundIssue found, bool addComment, Guid actorUserId, CancellationToken ct)
    {
        if (IsPullRequest(found.ExternalId))
        {
            return await LinkPullRequestAsync(comment, connection, found, addComment, actorUserId, ct);
        }

        var tracker = trackers.For(connection.Kind);
        var settings = SettingsOf(connection);
        var token = await accounts.RequireForUserAsync(connection, actorUserId, ct);
        var now = clock.GetUtcNow().UtcDateTime;
        if (addComment)
        {
            var (fileLines, later) = await PlaceFilesAsync(connection, tracker, settings, token, comment, ct);
            var note = $"**Linked from Inklayer**\n\n{await IssueBodyAsync(comment, ct, fileLines)}";
            var noteId = await accounts.WithAsync(token, t => tracker.AddCommentAsync(settings, t, found.ExternalId, note, ct), ct);
            await AttachLaterAsync(connection, tracker, settings, token, found.ExternalId, found.Key, later, ct);
            await AddPostedAsync(connection.Id, found.ExternalId, noteId, actorUserId, note, null, now, ct);
        }

        var issue = new AnnotationIssue
        {
            AnnotationId = comment.Id, ConnectionId = connection.Id, ExternalId = found.ExternalId, Key = found.Key, Url = found.Url, State = found.State,
            Title = Clip(found.Title), ClosedAt = found.State == IssueStates.Closed ? now : null, Linked = true, CreatedByUserId = actorUserId, CreatedAt = now, LastSyncedAt = now,
        };
        db.AnnotationIssues.Add(issue);
        await db.SaveChangesAsync(ct);

        try
        {
            await ImportCommentsAsync(connection, found.ExternalId, null, token, ct);
            issue.CommentsCheckedAt = now;
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Linked all the same; the next sync tries again.
            connection.LastError = Clip($"Reading comments on {found.Key}: {ex.Message}");
            connection.LastErrorAt = now;
            await db.SaveChangesAsync(ct);
        }

        await notifications.IssueCreatedAsync(comment, actorUserId, $"{TrackerKinds.Name(connection.Kind)} {issue.Key}", issue.Url, ct, linked: true);
        return issue;
    }

    /// <summary>
    /// Fetches the issue's comments changed since <paramref name="since"/> and stores them: new ones are added, edited
    /// ones updated. Comments Inklayer posted are recognised by their id and skipped. Returns the new ones.
    /// </summary>
    public async Task<List<IssueComment>> ImportCommentsAsync(
        IssueTrackerConnection connection, string issueExternalId, DateTime? since, TrackerToken token, CancellationToken ct)
    {
        var fetched = await accounts.WithAsync(token, t => trackers.For(connection.Kind).CommentsAsync(SettingsOf(connection), t, issueExternalId, since, ct), ct);
        if (fetched.Count == 0)
        {
            return [];
        }

        var ids = fetched.Select(c => c.ExternalId).ToList();
        var known = await db.IssueComments.Where(c => c.ConnectionId == connection.Id && c.IssueExternalId == issueExternalId && ids.Contains(c.ExternalId))
            .ToDictionaryAsync(c => c.ExternalId, ct);
        var added = new List<IssueComment>();
        foreach (var c in fetched)
        {
            var body = Clip(c.Body, 20_000);
            if (known.TryGetValue(c.ExternalId, out var existing))
            {
                if (!existing.FromInklayer && (existing.Body != body || existing.UpdatedAt != c.UpdatedAt))
                {
                    existing.Body = body;
                    existing.AuthorName = Clip(c.AuthorName, 200);
                    existing.UpdatedAt = c.UpdatedAt;
                }

                continue;
            }

            var comment = new IssueComment
            {
                ConnectionId = connection.Id, IssueExternalId = issueExternalId, ExternalId = c.ExternalId, AuthorName = Clip(c.AuthorName, 200),
                AuthorUrl = c.AuthorUrl is { Length: <= 500 } url ? url : null, Body = body, CreatedAt = c.CreatedAt, UpdatedAt = c.UpdatedAt,
            };
            db.IssueComments.Add(comment);
            added.Add(comment);
        }

        await db.SaveChangesAsync(ct);
        return added;
    }

    /// <summary>
    /// A reply was written in Inklayer: post it on the comment's linked issues, where the connection says to, as its author's
    /// own account (else the shared one, with their name; else not at all). Failures are noted on the connection; the reply
    /// stands either way.
    /// </summary>
    public async Task ReplyAddedAsync(Annotation comment, AnnotationReply reply, CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.IssueTrackers, ct))
        {
            return;
        }

        var linked = await (from i in db.AnnotationIssues
                            where i.AnnotationId == comment.Id && !i.PullRequest
                            join c in db.IssueTrackerConnections on i.ConnectionId equals c.Id
                            where c.PostRepliesToIssue
                            select new { Issue = i, Connection = c }).ToListAsync(ct);
        if (linked.Count == 0)
        {
            return;
        }

        var people = Mentions.Extract(reply.Body).Append(reply.AuthorUserId).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var said = Mentions.ToNames(reply.Body, names).Trim();
        var view = $"[View in Inklayer]({Origin()}/comments/{comment.Id})";
        foreach (var link in linked.DistinctBy(l => (l.Issue.ConnectionId, l.Issue.ExternalId)))
        {
            var now = clock.GetUtcNow().UtcDateTime;
            if (await accounts.ForUserAsync(link.Connection, reply.AuthorUserId, ct) is not { } token)
            {
                // Neither their own account nor a shared one: the reply stays in Inklayer.
                continue;
            }

            // Their own account says who it is; the shared one needs the name.
            // Small print where the tracker renders markdown's HTML; Azure DevOps and Jira would show the tags.
            var footer = link.Connection.Kind is TrackerKinds.AzureDevOps or TrackerKinds.Jira ? view : $"<sub>{view}</sub>";
            var text = token.IsPersonal
                ? $"{said}\n\n{footer}"
                : $"**{names.GetValueOrDefault(reply.AuthorUserId, "Someone")}** (via Inklayer): {said}\n\n{view}";
            try
            {
                var id = await accounts.WithAsync(token, t => trackers.For(link.Connection.Kind).AddCommentAsync(
                    SettingsOf(link.Connection), t, link.Issue.ExternalId, text, ct), ct);
                await AddPostedAsync(link.Connection.Id, link.Issue.ExternalId, id, reply.AuthorUserId, text, reply.Id, now, ct);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                link.Connection.LastError = Clip($"Posting a reply on {link.Issue.Key}: {ex.Message}");
                link.Connection.LastErrorAt = now;
            }
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>Remembers a comment Inklayer posted, so syncing doesn't show it again as the tracker's.</summary>
    private async Task AddPostedAsync(Guid connectionId, string issueExternalId, string externalId, Guid authorUserId, string body, Guid? replyId, DateTime now, CancellationToken ct)
    {
        var name = await db.Users.Where(u => u.Id == authorUserId).Select(u => u.PreferredName ?? u.DisplayName).SingleOrDefaultAsync(ct) ?? "Inklayer";
        db.IssueComments.Add(new IssueComment
        {
            ConnectionId = connectionId, IssueExternalId = issueExternalId, ExternalId = externalId, AuthorName = Clip(name, 200), Body = Clip(body, 20_000),
            CreatedAt = now, UpdatedAt = now, FromInklayer = true, ReplyId = replyId,
        });
    }

    /// <summary>
    /// The comment was resolved in Inklayer: close its open issues where the connection says to, as whoever resolved it (else
    /// the shared account, else whoever linked the issue). Failures are noted on the connection.
    /// </summary>
    public async Task CommentResolvedAsync(Annotation comment, Guid actorUserId, CancellationToken ct)
    {
        if (!await features.IsEnabledAsync(Feature.IssueTrackers, ct))
        {
            return;
        }

        // Pull requests aren't closed: their summaries say the comment is resolved.
        await UpdateSummariesForAsync(comment.Id, actorUserId, ct);
        var open = await db.AnnotationIssues.Where(i => i.AnnotationId == comment.Id && i.State == IssueStates.Open && !i.PullRequest).ToListAsync(ct);
        foreach (var issue in open)
        {
            var connection = await db.IssueTrackerConnections.SingleOrDefaultAsync(c => c.Id == issue.ConnectionId, ct);
            if (connection is not { CloseIssueOnResolve: true })
            {
                continue;
            }

            // Several comments can share an issue: it closes with the last of them.
            var othersOpen = await (from i in db.AnnotationIssues
                                    where i.ConnectionId == issue.ConnectionId && i.ExternalId == issue.ExternalId && i.AnnotationId != comment.Id
                                    join a in db.Annotations on i.AnnotationId equals a.Id
                                    where a.DeletedAt == null && a.Status == AnnotationStatus.Open
                                    select i.Id).AnyAsync(ct);
            if (othersOpen)
            {
                continue;
            }

            var token = await accounts.ForUserAsync(connection, actorUserId, ct) ?? await accounts.ForBackgroundAsync(connection, [issue.CreatedByUserId], ct);
            if (token is null)
            {
                connection.LastError = Clip($"Couldn't close {issue.Key}: no one involved has connected a {TrackerKinds.Name(connection.Kind)} account, and there's no shared one.");
                connection.LastErrorAt = clock.GetUtcNow().UtcDateTime;
                continue;
            }

            try
            {
                await accounts.WithAsync(token, async t =>
                {
                    await trackers.For(connection.Kind).CloseAsync(SettingsOf(connection), t, issue.ExternalId, ct);
                    return true;
                }, ct);
                issue.State = IssueStates.Closed;
                issue.LastSyncedAt = clock.GetUtcNow().UtcDateTime;
                issue.ClosedAt = issue.LastSyncedAt;
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
                          select new { i.AnnotationId, Issue = new IssueResponse(i.Id, c.Kind, i.Key, i.Url, i.State, i.PullRequest) }).ToListAsync(ct);
        return rows.GroupBy(r => r.AnnotationId).ToDictionary(g => g.Key, g => g.Select(r => r.Issue).ToList());
    }

    /// <summary>The tracker's comments on each comment's linked issues, oldest first; not the ones Inklayer posted.</summary>
    public static async Task<Dictionary<Guid, List<IssueCommentResponse>>> CommentsForAsync(InklayerDbContext db, List<Guid> annotationIds, CancellationToken ct)
    {
        var rows = await (from i in db.AnnotationIssues.AsNoTracking()
                          where annotationIds.Contains(i.AnnotationId)
                          join c in db.IssueTrackerConnections on i.ConnectionId equals c.Id
                          join ic in db.IssueComments.AsNoTracking() on new { i.ConnectionId, IssueExternalId = i.ExternalId } equals new { ic.ConnectionId, ic.IssueExternalId }
                          where !ic.FromInklayer
                          select new
                          {
                              i.AnnotationId,
                              Comment = new IssueCommentResponse(ic.Id, c.Kind, i.Key, i.Url, ic.AuthorName, ic.AuthorUrl, ic.Body, ic.CreatedAt, ic.UpdatedAt),
                          }).ToListAsync(ct);
        return rows.GroupBy(r => r.AnnotationId).ToDictionary(g => g.Key, g => g.Select(r => r.Comment).OrderBy(c => c.CreatedAt).ToList());
    }

    /// <summary>The comment, its replies, where it is, and the page details: what a developer needs to pick it up.</summary>
    private async Task<string> IssueBodyAsync(Annotation comment, CancellationToken ct, IReadOnlyList<string>? files = null)
    {
        var replies = await db.AnnotationReplies.AsNoTracking().Where(r => r.AnnotationId == comment.Id && r.DeletedAt == null).OrderBy(r => r.CreatedAt).ToListAsync(ct);
        var people = replies.Select(r => r.AuthorUserId).Append(comment.AuthorUserId).Concat(Mentions.Extract(comment.Body))
            .Concat(replies.SelectMany(r => Mentions.Extract(r.Body))).Distinct().ToList();
        var names = await db.Users.AsNoTracking().Where(u => people.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var context = await db.AnnotationContexts.AsNoTracking().SingleOrDefaultAsync(c => c.AnnotationId == comment.Id, ct);
        var origin = Origin();

        var body = new StringBuilder();
        body.AppendLine(Mentions.ToNames(comment.Body, names).Trim());
        body.AppendLine();
        body.AppendLine($"**Page:** {Link(comment.PageUrl)}");
        body.AppendLine($"**Reported by:** {names.GetValueOrDefault(comment.AuthorUserId, "someone")} in Inklayer: {Link($"{origin}/comments/{comment.Id}")}");
        body.AppendLine($"**Commented:** {When(comment.CreatedAt, context)}");
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
            body.AppendLine($"**Browser:** {c.Browser} on {c.Os}, {c.ViewportWidth}×{c.ViewportHeight} @{c.DevicePixelRatio}x{(c.Zoom is { } z && Math.Abs(z - 1) > 0.01 ? $", zoomed to {Math.Round(z * 100)}%" : "")}");
            if (c.Selector.Length > 0)
            {
                body.AppendLine($"**Element:** `{c.Selector}`");
            }

            if (c.Scripts is { Count: > 0 } scripts)
            {
                body.AppendLine($"**Page build:** {string.Join(", ", scripts.Select(name => $"`{name.Replace("`", "", StringComparison.Ordinal)}`"))}");
            }

            if (c.IpNetwork.Length > 0 || c.IpCountry.Length > 0)
            {
                var place = c.IpNetwork.Length > 0 && c.IpCountry.Length > 0 ? $"{c.IpNetwork} ({c.IpCountry})" : c.IpNetwork + c.IpCountry;
                body.AppendLine($"**Network:** {place}{c.IpNetworkKind switch
                {
                    "vpn" => ", likely a VPN",
                    "hosting" => ", a hosting provider (likely a VPN or proxy)",
                    _ => "",
                }}");
            }

            foreach (var e in c.Console.Take(10))
            {
                body.AppendLine($"- console.{e.Level}: {e.Message}");
            }

            foreach (var n in c.Network.Take(10))
            {
                body.AppendLine($"- {n.Method} {n.Url} → {(n.Status == 0 ? "failed" : n.Status)}");
            }
        }

        // The screenshot and other files: shown or attached as the tracker allows (see PlaceFilesAsync).
        if (files is { Count: > 0 })
        {
            body.AppendLine();
            foreach (var line in files)
            {
                body.AppendLine(line);
            }
        }

        return body.ToString().TrimEnd();
    }

    /// <summary>An address as a Markdown link to itself, with the characters that would end the link escaped.</summary>
    private static string Link(string url)
    {
        var safe = url.Replace(" ", "%20", StringComparison.Ordinal).Replace("(", "%28", StringComparison.Ordinal).Replace(")", "%29", StringComparison.Ordinal);
        return $"[{url.Replace("[", "%5B", StringComparison.Ordinal).Replace("]", "%5D", StringComparison.Ordinal)}]({safe})";
    }

    /// <summary>When the comment was made, in the commenter's time zone where it's known: "21 Nov 2026, 21:32 (Australia/Brisbane, UTC+10:00)".</summary>
    internal static string When(DateTime createdAtUtc, AnnotationContext? context)
    {
        var utc = DateTime.SpecifyKind(createdAtUtc, DateTimeKind.Utc);
        string Format(DateTime at, TimeSpan offset, string? zone)
        {
            var sign = offset < TimeSpan.Zero ? "-" : "+";
            var label = $"UTC{sign}{offset.Duration():hh\\:mm}";
            return $"{at.ToString("d MMM yyyy, HH:mm", System.Globalization.CultureInfo.InvariantCulture)} ({(zone is { Length: > 0 } ? $"{zone}, {label}" : label)})";
        }

        if (context?.TimeZone is { Length: > 0 } zone && TimeZoneInfo.TryFindSystemTimeZoneById(zone, out var tz))
        {
            var local = TimeZoneInfo.ConvertTimeFromUtc(utc, tz);
            return Format(local, tz.GetUtcOffset(utc), zone);
        }

        if (context?.UtcOffsetMinutes is { } minutes)
        {
            var offset = TimeSpan.FromMinutes(minutes);
            return Format(utc + offset, offset, null);
        }

        return Format(utc, TimeSpan.Zero, null).Replace("(UTC+00:00)", "(UTC)", StringComparison.Ordinal);
    }

    private static string Shorten(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host + u.AbsolutePath : url;

    private string Origin() => http.HttpContext is { } h ? McpResource.Origin(h.Request) : (configuration["Inklayer:PublicUrl"] ?? "").TrimEnd('/');

    private static string Clip(string text, int max = 300) => text.Length > max ? text[..(max - 1)] + "…" : text;
}
