using System.ComponentModel.DataAnnotations;
using System.Security.Cryptography;
using Inklayer.Api.Access;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Notifications;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Notifications;

public sealed record NotificationActor(Guid Id, string DisplayName, string FullName);

public sealed record NotificationResponse(
    Guid Id, [property: AllowedValues(NotificationKinds.Mention, NotificationKinds.Reply, NotificationKinds.Resolved, NotificationKinds.IssueClosed, NotificationKinds.IssueComment, NotificationKinds.AccessRequested, NotificationKinds.AccessGranted, NotificationKinds.AccessDeclined)] string Kind, NotificationActor? Actor, Guid OrganizationId, Guid? AnnotationId, Guid? DocId, string Preview, string Where, DateTime CreatedAt, bool Read, Guid? ProjectId = null);

public sealed record InboxResponse(int Unread, IReadOnlyList<NotificationResponse> Items);

/// <summary>Mark some (by id) or all as read.</summary>
public sealed record MarkReadRequest(List<Guid>? Ids, bool All = false);

public sealed record PersonResponse(Guid Id, string DisplayName, string FullName);

/// <param name="Target">Where it sends to, shortened (e.g. hooks.slack.com/…/a1b2), never the full secret address.</param>
public sealed record IntegrationResponse(
    Guid Id, [property: AllowedValues(IntegrationKinds.Email, IntegrationKinds.Slack, IntegrationKinds.Webhook)] string Kind, string Name, bool Enabled, IReadOnlyList<string> Events, Guid? ProjectId, string? Target,
    DateTime? LastSuccessAt, DateTime? LastErrorAt, string? LastError);

/// <param name="Secret">Webhooks only, and only now: the key receivers check signatures with.</param>
public sealed record IntegrationCreatedResponse(IntegrationResponse Integration, string? Secret);

public sealed record CreateIntegrationRequest(string Kind, string? Name, string? Url, List<string>? Events, Guid? ProjectId);

public sealed record UpdateIntegrationRequest(string? Name, bool? Enabled, string? Url, List<string>? Events, Guid? ProjectId, bool ClearProject = false);

public sealed record TestResultResponse(bool Ok, string? Error);

public sealed record EmailSetupResponse(bool Configured, string? From);

/// <summary>
/// Notifications: everyone's in-app inbox; @mention suggestions; and organisations' integrations (email, Slack, webhooks),
/// managed by organisation Admins. Email itself is set up on the server (<see cref="SmtpOptions"/>).
/// </summary>
internal static class NotificationEndpoints
{
    public static IEndpointRouteBuilder MapNotificationEndpoints(this IEndpointRouteBuilder app)
    {
        var inbox = app.MapGroup("/api/notifications").WithTags("Notifications").RequireAuthorization();
        inbox.MapGet("/", InboxAsync).WithChangeStamp(ChangeAreas.Notifications).Produces<InboxResponse>().WithSummary("Your notifications, newest first, with how many are unread: ?before=&limit=");
        inbox.MapPost("/read", MarkReadAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Mark notifications as read");

        app.MapGet("/api/orgs/{orgId:guid}/members/lookup", LookupAsync).Produces<List<PersonResponse>>().WithTags("Organizations").RequireAuthorization()
            .WithSummary("Members whose name matches ?q=, for @mentions (names only)");

        var integrations = app.MapGroup("/api/orgs/{orgId:guid}/integrations").WithTags("Notifications").RequireAuthorization();
        integrations.MapGet("/", ListAsync).Produces<List<IntegrationResponse>>().WithSummary("Where the organisation's notifications go (organisation Admins)");
        integrations.MapPost("/", CreateAsync).Produces<IntegrationCreatedResponse>(StatusCodes.Status201Created).WithSummary("Add an email, Slack or webhook integration");
        integrations.MapPatch("/{id:guid}", UpdateAsync).Produces<IntegrationResponse>();
        integrations.MapDelete("/{id:guid}", DeleteAsync).Produces(StatusCodes.Status204NoContent);
        integrations.MapPost("/{id:guid}/test", TestAsync).Produces<TestResultResponse>().WithSummary("Send a test message now");
        return app;
    }

    public static RouteGroupBuilder MapAdminEmailEndpoints(this RouteGroupBuilder admin)
    {
        admin.MapGet("/email", (IEmailSender email, Microsoft.Extensions.Options.IOptions<SmtpOptions> options) =>
            TypedResults.Ok(new EmailSetupResponse(email.IsConfigured, email.IsConfigured ? options.Value.From : null)))
            .WithSummary("Whether the server can send email (set with INKLAYER_SMTP_*)");
        admin.MapPost("/email/test", async (CurrentUser currentUser, IEmailSender email, CancellationToken ct) =>
        {
            var user = await currentUser.GetAsync(ct);
            try
            {
                await email.SendAsync(user!.Email, "Inklayer: test email", "This is a test from Inklayer. Email notifications work.", ct);
                return TypedResults.Ok(new TestResultResponse(true, null));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return TypedResults.Ok(new TestResultResponse(false, ex.Message));
            }
        }).WithSummary("Send yourself a test email");
        return admin;
    }

    /* ------------------------------------------------------------------ inbox */

    private static async Task<IResult> InboxAsync(DateTime? before, int? limit, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var userId = currentUser.Id!.Value;
        var query = db.Notifications.AsNoTracking().Where(n => n.UserId == userId);
        var unread = await query.CountAsync(n => n.ReadAt == null, ct);
        if (before is { } b)
        {
            query = query.Where(n => n.CreatedAt < b);
        }

        var rows = await query.OrderByDescending(n => n.CreatedAt).Take(Math.Clamp(limit ?? 30, 1, 100)).ToListAsync(ct);
        var actorIds = rows.Select(r => r.ActorUserId).OfType<Guid>().Distinct().ToList();
        var actors = await db.Users.AsNoTracking().Where(u => actorIds.Contains(u.Id))
            .ToDictionaryAsync(u => u.Id, u => new NotificationActor(u.Id, u.PreferredName ?? u.DisplayName, u.DisplayName), ct);
        return TypedResults.Ok(new InboxResponse(unread, [.. rows.Select(n => new NotificationResponse(
            n.Id, n.Kind, n.ActorUserId is { } a ? actors.GetValueOrDefault(a) : null, n.OrganizationId, n.AnnotationId, n.DocId, n.Preview, n.Where, n.CreatedAt, n.ReadAt is not null, n.ProjectId))]));
    }

    private static async Task<IResult> MarkReadAsync(MarkReadRequest request, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var userId = currentUser.Id!.Value;
        var now = clock.GetUtcNow().UtcDateTime;
        var query = db.Notifications.Where(n => n.UserId == userId && n.ReadAt == null);
        if (!request.All)
        {
            var ids = request.Ids ?? [];
            query = query.Where(n => ids.Contains(n.Id));
        }

        await query.ExecuteUpdateAsync(s => s.SetProperty(n => n.ReadAt, now), ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> LookupAsync(Guid orgId, string? q, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var term = (q ?? "").Trim().ToLowerInvariant();
        var people = await db.OrganizationMembers.AsNoTracking().Where(m => m.OrganizationId == orgId)
            .Select(m => new { m.User!.Id, m.User.DisplayName, m.User.PreferredName, m.User.IsDisabled })
            .ToListAsync(ct);
        return TypedResults.Ok(people
            .Where(p => !p.IsDisabled && (term.Length == 0
                || (p.PreferredName ?? "").Contains(term, StringComparison.OrdinalIgnoreCase)
                || p.DisplayName.Contains(term, StringComparison.OrdinalIgnoreCase)))
            .OrderBy(p => (p.PreferredName ?? p.DisplayName).StartsWith(term, StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .ThenBy(p => p.PreferredName ?? p.DisplayName, StringComparer.OrdinalIgnoreCase)
            .Take(8)
            .Select(p => new PersonResponse(p.Id, p.PreferredName ?? p.DisplayName, p.DisplayName))
            .ToList());
    }

    /* ------------------------------------------------------------------ integrations */

    private static async Task<IResult> ListAsync(Guid orgId, AccessService access, InklayerDbContext db, IntegrationSecrets secrets, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var rows = await db.Integrations.AsNoTracking().Where(i => i.OrganizationId == orgId).OrderBy(i => i.CreatedAt).ToListAsync(ct);
        return TypedResults.Ok(rows.Select(i => ToResponse(i, secrets)).ToList());
    }

    private static async Task<IResult> CreateAsync(
        Guid orgId, CreateIntegrationRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets,
        IEmailSender email, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (request.Kind is not (IntegrationKinds.Email or IntegrationKinds.Slack or IntegrationKinds.Webhook))
        {
            return Invalid("kind", "Choose email, slack or webhook.");
        }

        if (request.Kind == IntegrationKinds.Email && !email.IsConfigured)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This server can't send email yet. An instance administrator sets INKLAYER_SMTP_HOST and INKLAYER_SMTP_FROM.");
        }

        if (request.Kind != IntegrationKinds.Email && !ValidUrl(request.Url))
        {
            return Invalid("url", "Use an https:// address.");
        }

        if (Events(request.Events) is not { } events)
        {
            return Invalid("events", $"Events must be among: {string.Join(", ", IntegrationEvents.All)}.");
        }

        if (request.ProjectId is { } projectId && !await db.Projects.AnyAsync(p => p.Id == projectId && p.OrganizationId == orgId, ct))
        {
            return Invalid("projectId", "That project isn't in this organisation.");
        }

        var secret = request.Kind == IntegrationKinds.Webhook ? WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32)) : null;
        var integration = new Integration
        {
            OrganizationId = orgId,
            Kind = request.Kind,
            Name = Name(request.Name, request.Kind),
            Events = events,
            ProjectId = request.ProjectId,
            ProtectedUrl = request.Kind == IntegrationKinds.Email ? null : secrets.Protect(request.Url!.Trim()),
            ProtectedSecret = secret is null ? null : secrets.Protect(secret),
            CreatedByUserId = currentUser.Id!.Value,
            CreatedAt = clock.GetUtcNow().UtcDateTime,
        };
        db.Integrations.Add(integration);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/orgs/{orgId}/integrations/{integration.Id}", new IntegrationCreatedResponse(ToResponse(integration, secrets), secret));
    }

    private static async Task<IResult> UpdateAsync(
        Guid orgId, Guid id, UpdateIntegrationRequest request, AccessService access, InklayerDbContext db, IntegrationSecrets secrets, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var integration = await db.Integrations.SingleOrDefaultAsync(i => i.Id == id && i.OrganizationId == orgId, ct);
        if (integration is null)
        {
            return TypedResults.NotFound();
        }

        if (request.Url is not null)
        {
            if (integration.Kind == IntegrationKinds.Email || !ValidUrl(request.Url))
            {
                return Invalid("url", "Use an https:// address.");
            }

            integration.ProtectedUrl = secrets.Protect(request.Url.Trim());
        }

        if (request.Events is not null)
        {
            if (Events(request.Events) is not { } events)
            {
                return Invalid("events", $"Events must be among: {string.Join(", ", IntegrationEvents.All)}.");
            }

            integration.Events = events;
        }

        if (request.ProjectId is { } projectId)
        {
            if (!await db.Projects.AnyAsync(p => p.Id == projectId && p.OrganizationId == orgId, ct))
            {
                return Invalid("projectId", "That project isn't in this organisation.");
            }

            integration.ProjectId = projectId;
        }
        else if (request.ClearProject)
        {
            integration.ProjectId = null;
        }

        integration.Name = request.Name is null ? integration.Name : Name(request.Name, integration.Kind);
        integration.Enabled = request.Enabled ?? integration.Enabled;
        await db.SaveChangesAsync(ct);
        return TypedResults.Ok(ToResponse(integration, secrets));
    }

    private static async Task<IResult> DeleteAsync(Guid orgId, Guid id, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var deleted = await db.Integrations.Where(i => i.Id == id && i.OrganizationId == orgId).ExecuteDeleteAsync(ct);
        return deleted == 0 ? TypedResults.NotFound() : TypedResults.NoContent();
    }

    private static async Task<IResult> TestAsync(
        Guid orgId, Guid id, AccessService access, CurrentUser currentUser, InklayerDbContext db, NotificationDispatcher dispatcher, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckOrganizationAsync(orgId, Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var integration = await db.Integrations.SingleOrDefaultAsync(i => i.Id == id && i.OrganizationId == orgId, ct);
        if (integration is null)
        {
            return TypedResults.NotFound();
        }

        var user = await currentUser.GetAsync(ct);
        var now = clock.GetUtcNow().UtcDateTime;
        var message = integration.Kind switch
        {
            IntegrationKinds.Email => new OutboundMessage { Kind = IntegrationKinds.Email, To = user!.Email, Subject = "Inklayer: test email", Body = "This is a test from Inklayer.", CreatedAt = now },
            IntegrationKinds.Slack => new OutboundMessage { Kind = IntegrationKinds.Slack, IntegrationId = id, Subject = "test", Body = """{"text":"This is a test from Inklayer."}""", CreatedAt = now },
            _ => new OutboundMessage { Kind = IntegrationKinds.Webhook, IntegrationId = id, Subject = "test", Body = $$"""{"event":"test","at":"{{now:O}}"}""", CreatedAt = now },
        };
        try
        {
            await dispatcher.SendAsync(message, integration, ct);
            integration.LastSuccessAt = now;
            await db.SaveChangesAsync(ct);
            return TypedResults.Ok(new TestResultResponse(true, null));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            integration.LastError = ex.Message.Length > 300 ? ex.Message[..300] : ex.Message;
            integration.LastErrorAt = now;
            await db.SaveChangesAsync(ct);
            return TypedResults.Ok(new TestResultResponse(false, ex.Message));
        }
    }

    private static IntegrationResponse ToResponse(Integration i, IntegrationSecrets secrets) => new(
        i.Id, i.Kind, i.Name, i.Enabled, i.Events.Split(' ', StringSplitOptions.RemoveEmptyEntries), i.ProjectId,
        i.ProtectedUrl is { } url ? Hint(secrets.Unprotect(url)) : null, i.LastSuccessAt, i.LastErrorAt, i.LastError);

    /// <summary>host/…/last4: enough to recognise it, not enough to use it (Slack webhook addresses are secrets).</summary>
    private static string Hint(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) ? $"{u.Host}/…/{(u.AbsolutePath.Length >= 4 ? u.AbsolutePath[^4..] : u.AbsolutePath)}" : "…";

    private static bool ValidUrl(string? url) =>
        Uri.TryCreate(url?.Trim(), UriKind.Absolute, out var u) && u.Scheme == Uri.UriSchemeHttps && u.UserInfo.Length == 0;

    private static string? Events(List<string>? events)
    {
        var list = events is null || events.Count == 0 ? IntegrationEvents.All.ToList() : events.Distinct().ToList();
        return list.All(e => IntegrationEvents.All.Contains(e)) ? string.Join(' ', list) : null;
    }

    private static string Name(string? name, string kind)
    {
        var trimmed = (name ?? "").Trim();
        trimmed = trimmed.Length == 0 ? kind switch { IntegrationKinds.Email => "Email", IntegrationKinds.Slack => "Slack", _ => "Webhook" } : trimmed;
        return trimmed.Length > 100 ? trimmed[..100] : trimmed;
    }

    private static IResult Invalid(string field, string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });
}
