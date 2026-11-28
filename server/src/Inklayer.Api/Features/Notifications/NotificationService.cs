using System.Text.Json;
using Inklayer.Api.Auth;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Domain.Notifications;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Notifications;

/// <summary>Encrypts integration webhook addresses and secrets at rest, with the server's Data Protection keys.</summary>
internal sealed class IntegrationSecrets(IDataProtectionProvider provider)
{
    private readonly IDataProtector _protector = provider.CreateProtector("Inklayer.Integrations.v1");

    public string Protect(string value) => _protector.Protect(value);

    public string Unprotect(string value) => _protector.Unprotect(value);
}

/// <summary>
/// Who hears about what. People get in-app notifications when they're @mentioned, when someone replies in a thread they're
/// in, and when their comment is resolved; only members of the organisation, and never for their own actions. Mentions are
/// only new ones when text is edited. Organisations' integrations (email, Slack, webhooks) get the same events, queued in
/// the outbox and sent by <see cref="NotificationDispatcher"/>.
/// </summary>
internal sealed class NotificationService(InklayerDbContext db, IEmailSender email, IHttpContextAccessor http, IConfiguration configuration, TimeProvider clock)
{
    private const int PreviewLength = 280;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task CommentCreatedAsync(Annotation comment, CancellationToken ct)
    {
        var mentioned = Mentions.Extract(comment.Body);
        await NotifyAsync(NotificationKinds.Mention, mentioned, comment.OrganizationId, comment.AuthorUserId, comment, null, comment.Body, ct);
        await EventAsync(IntegrationEvents.CommentCreated, comment, comment.AuthorUserId, comment.Body, "commented", ct);
        if (mentioned.Count > 0)
        {
            await EventAsync(IntegrationEvents.Mention, comment, comment.AuthorUserId, comment.Body, "mentioned people", ct);
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>Only people mentioned for the first time are notified.</summary>
    public async Task CommentEditedAsync(Annotation comment, string oldBody, Guid actorUserId, CancellationToken ct)
    {
        var added = Mentions.Extract(comment.Body).Except(Mentions.Extract(oldBody)).ToList();
        await NotifyAsync(NotificationKinds.Mention, added, comment.OrganizationId, actorUserId, comment, null, comment.Body, ct);
        await db.SaveChangesAsync(ct);
    }

    public async Task ReplyAsync(Annotation comment, AnnotationReply reply, CancellationToken ct)
    {
        var mentioned = Mentions.Extract(reply.Body);
        var participants = await db.AnnotationReplies.Where(r => r.AnnotationId == comment.Id && r.DeletedAt == null && r.Id != reply.Id)
            .Select(r => r.AuthorUserId).ToListAsync(ct);
        participants.Add(comment.AuthorUserId);
        await NotifyAsync(NotificationKinds.Mention, mentioned, comment.OrganizationId, reply.AuthorUserId, comment, null, reply.Body, ct);
        await NotifyAsync(NotificationKinds.Reply, [.. participants.Distinct().Except(mentioned)], comment.OrganizationId, reply.AuthorUserId, comment, null, reply.Body, ct);
        await EventAsync(IntegrationEvents.Reply, comment, reply.AuthorUserId, reply.Body, "replied", ct);
        await db.SaveChangesAsync(ct);
    }

    public async Task ReplyEditedAsync(Annotation comment, AnnotationReply reply, string oldBody, Guid actorUserId, CancellationToken ct)
    {
        var added = Mentions.Extract(reply.Body).Except(Mentions.Extract(oldBody)).ToList();
        await NotifyAsync(NotificationKinds.Mention, added, comment.OrganizationId, actorUserId, comment, null, reply.Body, ct);
        await db.SaveChangesAsync(ct);
    }

    public async Task ResolvedAsync(Annotation comment, Guid actorUserId, CancellationToken ct)
    {
        await NotifyAsync(NotificationKinds.Resolved, [comment.AuthorUserId], comment.OrganizationId, actorUserId, comment, null, comment.Body, ct);
        await EventAsync(IntegrationEvents.Resolved, comment, actorUserId, comment.Body, "resolved", ct);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>A linked issue was closed in the tracker, which resolved the comment.</summary>
    public async Task IssueClosedAsync(Annotation comment, Guid issueCreatorUserId, string issueKey, CancellationToken ct)
    {
        await NotifyAsync(NotificationKinds.IssueClosed, [comment.AuthorUserId, issueCreatorUserId], comment.OrganizationId, null, comment, null, $"{issueKey} was closed", ct);
        await db.SaveChangesAsync(ct);
    }

    public async Task IssueCreatedAsync(Annotation comment, Guid actorUserId, string issueKey, string issueUrl, CancellationToken ct, bool linked = false)
    {
        await EventAsync(IntegrationEvents.IssueCreated, comment, actorUserId, $"{issueKey}: {issueUrl}", linked ? "linked an issue to" : "created an issue for", ct);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>New mentions in a doc, comparing its text before and after an edit.</summary>
    public async Task DocEditedAsync(Doc doc, string oldContent, Guid actorUserId, CancellationToken ct)
    {
        var added = Mentions.Extract(doc.Content).Except(Mentions.Extract(oldContent)).ToList();
        if (added.Count == 0)
        {
            return;
        }

        // The preview is the line with the mention.
        var line = doc.Content.Split('\n').FirstOrDefault(l => added.Any(id => l.Contains(id.ToString(), StringComparison.OrdinalIgnoreCase))) ?? doc.Title;
        await NotifyAsync(NotificationKinds.Mention, added, doc.OrganizationId, actorUserId, null, doc, line, ct);

        // People who have it through an organisation it's shared with hear of it there, once each.
        var homeMembers = await db.OrganizationMembers.Where(m => m.OrganizationId == doc.OrganizationId && added.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        var rest = added.Except(homeMembers).ToHashSet();
        foreach (var orgId in await db.DocOrgShares.Where(s => s.DocId == doc.Id).Select(s => s.OrganizationId).ToListAsync(ct))
        {
            if (rest.Count == 0)
            {
                break;
            }

            var here = await db.OrganizationMembers.Where(m => m.OrganizationId == orgId && rest.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
            await NotifyAsync(NotificationKinds.Mention, here, orgId, actorUserId, null, doc, line, ct);
            rest.ExceptWith(here);
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>
    /// Someone commented on a linked issue in the tracker: tell the comment's author, the people in its thread, and whoever
    /// created or linked the issue.
    /// </summary>
    public async Task IssueCommentAsync(Annotation comment, IReadOnlyCollection<Guid> issueCreators, string issueKey, string authorName, string body, CancellationToken ct)
    {
        var people = await db.AnnotationReplies.Where(r => r.AnnotationId == comment.Id && r.DeletedAt == null).Select(r => r.AuthorUserId).ToListAsync(ct);
        people.Add(comment.AuthorUserId);
        people.AddRange(issueCreators);
        await NotifyAsync(NotificationKinds.IssueComment, [.. people.Distinct()], comment.OrganizationId, null, comment, null, $"{authorName} on {issueKey}: {body}", ct);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Someone asked for access to a product: tell <paramref name="deciders"/> (its Managers and the organisation's Admins).</summary>
    public async Task AccessRequestedAsync(AccessRequest request, string productName, IReadOnlyCollection<Guid> deciders, CancellationToken ct)
    {
        var text = request.Message.Length > 0 ? $"Asked to be {request.Role}: {request.Message}" : $"Asked to be {request.Role}";
        await NotifyAsync(NotificationKinds.AccessRequested, deciders, request.OrganizationId, request.UserId, null, null, text, ct, (request.ResourceId, productName));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>A request was approved (with <paramref name="role"/>) or declined: tell the person who asked.</summary>
    public async Task AccessDecidedAsync(AccessRequest request, string productName, Role? role, Guid actorUserId, CancellationToken ct)
    {
        var (kind, text) = role is { } r
            ? (NotificationKinds.AccessGranted, $"You're now {r} on {productName}")
            : (NotificationKinds.AccessDeclined, $"Your request for access to {productName} was declined");
        await NotifyAsync(kind, [request.UserId], request.OrganizationId, actorUserId, null, null, text, ct, (request.ResourceId, productName));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>People were assigned tasks on a kanban: tell each (not whoever assigned them).</summary>
    public async Task TasksAssignedAsync(Doc kanban, IReadOnlyList<Kanban.KanbanIndexer.Assignment> assigned, Guid actorUserId, CancellationToken ct)
    {
        foreach (var a in assigned)
        {
            await NotifyTaskAsync(NotificationKinds.TaskAssigned, a.Added, kanban, actorUserId, a.Task, $"{a.Task.Key} {a.Task.Title}", ct);
        }

        await db.SaveChangesAsync(ct);
    }

    /// <summary>A task is due today, or overdue: tell its assignees.</summary>
    public async Task TaskDueAsync(Doc kanban, KanbanTask task, bool overdue, CancellationToken ct)
    {
        var due = task.Due?.ToString("d MMM yyyy", System.Globalization.CultureInfo.InvariantCulture) ?? "";
        await NotifyTaskAsync(overdue ? NotificationKinds.TaskOverdue : NotificationKinds.TaskDue, [.. task.Assignees.Select(a => a.UserId)], kanban, null, task,
            overdue ? $"{task.Key} {task.Title} was due {due}" : $"{task.Key} {task.Title} is due today", ct);
        await db.SaveChangesAsync(ct);
    }

    /// <summary>To the people on the kanban's own organisation, or else an organisation it's shared with (as mentions in docs).</summary>
    private async Task NotifyTaskAsync(string kind, IReadOnlyList<Guid> people, Doc kanban, Guid? actorUserId, KanbanTask task, string text, CancellationToken ct)
    {
        await NotifyAsync(kind, people, kanban.OrganizationId, actorUserId, null, kanban, text, ct, taskKey: task.Key);
        var homeMembers = await db.OrganizationMembers.Where(m => m.OrganizationId == kanban.OrganizationId && people.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
        var rest = people.Except(homeMembers).ToHashSet();
        foreach (var orgId in await db.DocOrgShares.Where(s => s.DocId == kanban.Id).Select(s => s.OrganizationId).ToListAsync(ct))
        {
            if (rest.Count == 0)
            {
                break;
            }

            var here = await db.OrganizationMembers.Where(m => m.OrganizationId == orgId && rest.Contains(m.UserId)).Select(m => m.UserId).ToListAsync(ct);
            await NotifyAsync(kind, here, orgId, actorUserId, null, kanban, text, ct, taskKey: task.Key);
            rest.ExceptWith(here);
        }
    }

    /* ------------------------------------------------------------------ in-app and email */

    private async Task NotifyAsync(
        string kind, IReadOnlyCollection<Guid> recipients, Guid organizationId, Guid? actorUserId, Annotation? comment, Doc? doc, string text, CancellationToken ct,
        (Guid Id, string Name)? product = null, string? taskKey = null)
    {
        var ids = recipients.Where(r => r != actorUserId).Distinct().ToList();
        if (ids.Count == 0)
        {
            return;
        }

        // Only members of the organisation, who can see its comments and docs.
        var people = await db.OrganizationMembers.Where(m => m.OrganizationId == organizationId && ids.Contains(m.UserId))
            .Join(db.Users.Where(u => !u.IsDisabled), m => m.UserId, u => u.Id, (m, u) => new { u.Id, u.Email, u.EmailNotifications })
            .ToListAsync(ct);
        if (people.Count == 0)
        {
            return;
        }

        var preview = await PreviewAsync(text, ct);
        var where = comment?.PageUrl ?? doc?.Title ?? product?.Name ?? "";
        var now = clock.GetUtcNow().UtcDateTime;
        foreach (var person in people)
        {
            db.Notifications.Add(new Notification
            {
                UserId = person.Id, OrganizationId = organizationId, Kind = kind, ActorUserId = actorUserId, AnnotationId = comment?.Id, DocId = doc?.Id,
                ProjectId = product?.Id, TaskKey = taskKey,
                Preview = preview, Where = Clip(where, 300), CreatedAt = now,
            });
        }

        // Emails, if the organisation sends them and the server can.
        if (!email.IsConfigured || !await db.Integrations.AnyAsync(i => i.OrganizationId == organizationId && i.Kind == IntegrationKinds.Email && i.Enabled, ct))
        {
            return;
        }

        var actor = actorUserId is { } a ? (await NamesAsync([a], ct)).GetValueOrDefault(a, "Someone") : "Inklayer";
        var subject = kind switch
        {
            NotificationKinds.Mention => $"{actor} mentioned you",
            NotificationKinds.Reply => $"{actor} replied to a comment you're in",
            NotificationKinds.Resolved => $"{actor} resolved your comment",
            NotificationKinds.IssueClosed => "An issue linked to your comment was closed",
            NotificationKinds.IssueComment => "New comment on a linked issue",
            NotificationKinds.AccessRequested => $"{actor} asked for access",
            NotificationKinds.AccessGranted => $"{actor} gave you access",
            NotificationKinds.AccessDeclined => $"{actor} declined your access request",
            NotificationKinds.TaskAssigned => $"{actor} assigned you a task",
            NotificationKinds.TaskDue => "A task of yours is due today",
            NotificationKinds.TaskOverdue => "A task of yours is overdue",
            _ => "Inklayer",
        };
        var link = comment is not null ? $"{Origin()}/comments/{comment.Id}"
            : doc is not null ? $"{Origin()}/orgs/{organizationId}/docs/{doc.Id}{(taskKey is null ? "" : $"?task={Uri.EscapeDataString(taskKey)}")}"
            : product is { } p ? $"{Origin()}/projects/{p.Id}{(kind == NotificationKinds.AccessRequested ? "#access" : "")}"
            : Origin();
        var body = $"{subject}{(where.Length > 0 ? $" on {where}" : "")}:\n\n{preview}\n\nOpen it: {link}\n\n" +
            "You get these emails because your organisation sends Inklayer notifications by email. Turn them off in Inklayer's Settings.";
        foreach (var person in people.Where(p => p.EmailNotifications))
        {
            db.OutboundMessages.Add(new OutboundMessage
            {
                Kind = IntegrationKinds.Email, To = person.Email, Subject = Clip($"Inklayer: {subject}", 300), Body = body, NextAttemptAt = now, CreatedAt = now,
            });
        }
    }

    /* ------------------------------------------------------------------ Slack and webhooks */

    private async Task EventAsync(string @event, Annotation comment, Guid actorUserId, string text, string verb, CancellationToken ct)
    {
        var integrations = await db.Integrations.Where(i => i.OrganizationId == comment.OrganizationId && i.Enabled
                && (i.Kind == IntegrationKinds.Slack || i.Kind == IntegrationKinds.Webhook)
                && (i.ProjectId == null || i.ProjectId == comment.ProjectId))
            .ToListAsync(ct);
        integrations = [.. integrations.Where(i => i.Events.Split(' ').Contains(@event))];
        if (integrations.Count == 0)
        {
            return;
        }

        var actor = (await NamesAsync([actorUserId], ct)).GetValueOrDefault(actorUserId, "Someone");
        var preview = await PreviewAsync(text, ct);
        var link = $"{Origin()}/comments/{comment.Id}";
        var now = clock.GetUtcNow().UtcDateTime;
        foreach (var integration in integrations)
        {
            var body = integration.Kind == IntegrationKinds.Slack
                ? JsonSerializer.Serialize(new { text = $"*{SlackEscape(actor)}* {verb} on <{comment.PageUrl}|{SlackEscape(Shorten(comment.PageUrl))}>: {SlackEscape(preview)}  <{link}|Open in Inklayer>" }, Json)
                : JsonSerializer.Serialize(new
                {
                    @event, at = now, organizationId = comment.OrganizationId, projectId = comment.ProjectId,
                    actor = new { id = actorUserId, name = actor },
                    comment = new { id = comment.Id, url = link, pageUrl = comment.PageUrl, status = comment.Status.ToString(), text = preview },
                }, Json);
            db.OutboundMessages.Add(new OutboundMessage { Kind = integration.Kind, IntegrationId = integration.Id, Subject = @event, Body = body, NextAttemptAt = now, CreatedAt = now });
        }
    }

    /* ------------------------------------------------------------------ helpers */

    /// <summary>The text with mentions as names, cut for a preview.</summary>
    private async Task<string> PreviewAsync(string text, CancellationToken ct)
    {
        var names = await NamesAsync(Mentions.Extract(text), ct);
        return Clip(Mentions.ToNames(text, names).Trim(), PreviewLength);
    }

    private Task<Dictionary<Guid, string>> NamesAsync(IReadOnlyCollection<Guid> ids, CancellationToken ct) =>
        db.Users.AsNoTracking().Where(u => ids.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);

    /// <summary>The server's address for links: the current request's, or <c>Inklayer:PublicUrl</c> for background work.</summary>
    private string Origin() =>
        http.HttpContext is { } context ? McpResource.Origin(context.Request) : (configuration["Inklayer:PublicUrl"] ?? "").TrimEnd('/');

    private static string Shorten(string url) => Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host + u.AbsolutePath : url;

    private static string SlackEscape(string text) => text.Replace("&", "&amp;", StringComparison.Ordinal).Replace("<", "&lt;", StringComparison.Ordinal).Replace(">", "&gt;", StringComparison.Ordinal);

    private static string Clip(string text, int max) => text.Length > max ? text[..(max - 1)] + "…" : text;
}
