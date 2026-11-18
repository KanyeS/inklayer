using System.Security.Cryptography;
using System.Text;
using Inklayer.Api.Access;
using Inklayer.Api.Auth;
using Inklayer.Api.Features.Notifications;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Projects;
using Inklayer.Domain.Sharing;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Sharing;

public sealed record CreateShareRequest(string Kind, Guid? ProjectId = null, string? PageUrl = null, Guid? DocId = null, bool IncludeResolved = false, int? ExpiresInDays = null);

public sealed record ShareResponse(
    Guid Id, string Kind, string Url, Guid OrganizationId, Guid? ProjectId, string? ProjectName, string? PageUrl, Guid? DocId, string? DocTitle,
    bool IncludeResolved, string CreatedBy, DateTime CreatedAt, DateTime? ExpiresAt, bool Expired, int ViewCount, DateTime? LastViewedAt, bool CanRevoke);

/// <summary>
/// Read-only links for people without an account: a page's or a project's comments (Commenters and above in the project),
/// or a doc (Commenters and above in the organisation: "Make public"). Links can be revoked and can expire.
/// </summary>
internal static class ShareEndpoints
{
    public const int MaxExpiryDays = 365;

    public static IEndpointRouteBuilder MapShareEndpoints(this IEndpointRouteBuilder app)
    {
        var shares = app.MapGroup("/api/shares").WithTags("Sharing").RequireAuthorization();
        shares.MapPost("/", CreateAsync).WithSummary("Create a read-only link to a page's or project's comments, or make a doc public");
        shares.MapGet("/", ListAsync).WithSummary("A project's links (?projectId=) or a doc's public link (?docId=)");
        shares.MapDelete("/{id:guid}", RevokeAsync).WithSummary("Revoke a link: it stops working at once");
        app.MapGet("/api/admin/shares", AdminListAsync).WithTags("Admin", "Sharing").RequireAuthorization().WithSummary("Every working link (instance administrators)");
        return app;
    }

    internal static string Hash(string token) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    internal static async Task<IResult> CreateAsync(
        CreateShareRequest request, HttpContext http, AccessService access, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets,
        FeatureSwitches features, TimeProvider clock, CancellationToken ct)
    {
        if (!ShareKinds.All.Contains(request.Kind))
        {
            return Invalid("kind", "Choose page, project or doc.");
        }

        if (request.ExpiresInDays is < 1 or > MaxExpiryDays)
        {
            return Invalid("expiresInDays", $"Between 1 and {MaxExpiryDays} days, or leave it out for no expiry.");
        }

        Guid organizationId;
        string? pageUrl = null;
        if (request.Kind == ShareKinds.Doc)
        {
            if (!await features.IsEnabledAsync(Feature.Docs, ct))
            {
                return TypedResults.NotFound();
            }

            var doc = await db.Docs.AsNoTracking().Where(d => d.Id == request.DocId && d.DeletedAt == null).Select(d => new { d.Id, d.OrganizationId }).SingleOrDefaultAsync(ct);
            var check = doc is null ? AccessResult.NotFound() : await access.CheckOrganizationAsync(doc.OrganizationId, Permission.Comment, ct);
            if (!check.IsAllowed)
            {
                return check.Denied!;
            }

            // One public link per doc: making it public again gives the same link.
            var now = clock.GetUtcNow().UtcDateTime;
            var existing = await db.ShareLinks.AsNoTracking()
                .Where(s => s.DocId == doc!.Id && s.RevokedAt == null && (s.ExpiresAt == null || s.ExpiresAt > now)).FirstOrDefaultAsync(ct);
            if (existing is not null)
            {
                return TypedResults.Ok((await ToResponsesAsync(db, secrets, http, [existing], _ => true, now, ct))[0]);
            }

            organizationId = doc!.OrganizationId;
        }
        else
        {
            if (request.ProjectId is not { } projectId)
            {
                return Invalid("projectId", "Choose a project.");
            }

            var check = await access.CheckProjectAsync(projectId, Permission.Comment, ct);
            if (!check.IsAllowed)
            {
                return check.Denied!;
            }

            organizationId = check.OrganizationId;
            if (request.Kind == ShareKinds.Page)
            {
                pageUrl = request.PageUrl?.Trim();
                if (pageUrl is null || pageUrl.Length > ShareLink.MaxPageUrlLength || LivePageUrl.Candidates(pageUrl).Count == 0)
                {
                    return Invalid("pageUrl", "Must be the address of a web page (http or https).");
                }
            }
        }

        var token = Base64UrlToken();
        var created = clock.GetUtcNow().UtcDateTime;
        var share = new ShareLink
        {
            TokenHash = Hash(token),
            ProtectedToken = secrets.Protect(token),
            Kind = request.Kind,
            OrganizationId = organizationId,
            ProjectId = request.Kind == ShareKinds.Doc ? null : request.ProjectId,
            PageUrl = pageUrl,
            DocId = request.Kind == ShareKinds.Doc ? request.DocId : null,
            IncludeResolved = request.IncludeResolved,
            CreatedByUserId = currentUser.Id!.Value,
            CreatedAt = created,
            ExpiresAt = request.ExpiresInDays is { } days ? created.AddDays(days) : null,
        };
        db.ShareLinks.Add(share);
        await db.SaveChangesAsync(ct);
        return TypedResults.Created($"/api/shares/{share.Id}", (await ToResponsesAsync(db, secrets, http, [share], _ => true, created, ct))[0]);
    }

    internal static async Task<IResult> ListAsync(
        Guid? projectId, Guid? docId, HttpContext http, AccessService access, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets,
        TimeProvider clock, CancellationToken ct)
    {
        var now = clock.GetUtcNow().UtcDateTime;
        var me = currentUser.Id!.Value;
        if (projectId is { } p)
        {
            var check = await access.CheckProjectAsync(p, Permission.Comment, ct);
            if (!check.IsAllowed)
            {
                return check.Denied!;
            }

            var isAdmin = check.Role.Grants(Permission.ManageProjects);
            var rows = await db.ShareLinks.AsNoTracking().Where(s => s.ProjectId == p && s.RevokedAt == null).OrderByDescending(s => s.CreatedAt).Take(200).ToListAsync(ct);
            return TypedResults.Ok(await ToResponsesAsync(db, secrets, http, rows, s => isAdmin || s.CreatedByUserId == me, now, ct));
        }

        if (docId is { } d)
        {
            var orgId = await db.Docs.Where(x => x.Id == d && x.DeletedAt == null).Select(x => (Guid?)x.OrganizationId).SingleOrDefaultAsync(ct);
            var check = orgId is null ? AccessResult.NotFound() : await access.CheckOrganizationAsync(orgId.Value, Permission.View, ct);
            if (!check.IsAllowed)
            {
                return check.Denied!;
            }

            var canRevoke = check.Role.Grants(Permission.Comment);
            var rows = await db.ShareLinks.AsNoTracking().Where(s => s.DocId == d && s.RevokedAt == null).OrderByDescending(s => s.CreatedAt).ToListAsync(ct);
            return TypedResults.Ok(await ToResponsesAsync(db, secrets, http, rows, _ => canRevoke, now, ct));
        }

        return Invalid("projectId", "Give a projectId or a docId.");
    }

    private static async Task<IResult> RevokeAsync(Guid id, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        var share = await db.ShareLinks.SingleOrDefaultAsync(s => s.Id == id && s.RevokedAt == null, ct);
        if (share is null)
        {
            return TypedResults.NotFound();
        }

        var me = currentUser.Id!.Value;
        // Doc links: anyone who could make the doc public. Page and project links: who made them, or a project Admin.
        var check = share.DocId is { }
            ? await access.CheckOrganizationAsync(share.OrganizationId, Permission.Comment, ct)
            : await access.CheckProjectAsync(share.ProjectId!.Value, share.CreatedByUserId == me ? Permission.View : Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        share.RevokedAt = clock.GetUtcNow().UtcDateTime;
        share.RevokedByUserId = me;
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> AdminListAsync(
        HttpContext http, CurrentUser currentUser, InklayerDbContext db, IntegrationSecrets secrets, TimeProvider clock, CancellationToken ct)
    {
        if (await currentUser.GetAsync(ct) is not { IsSystemAdmin: true, IsDisabled: false })
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Instance administrators only.");
        }

        var now = clock.GetUtcNow().UtcDateTime;
        var rows = await db.ShareLinks.AsNoTracking().Where(s => s.RevokedAt == null && (s.ExpiresAt == null || s.ExpiresAt > now))
            .OrderByDescending(s => s.CreatedAt).Take(500).ToListAsync(ct);
        return TypedResults.Ok(await ToResponsesAsync(db, secrets, http, rows, _ => true, now, ct));
    }

    private static async Task<List<ShareResponse>> ToResponsesAsync(
        InklayerDbContext db, IntegrationSecrets secrets, HttpContext http, List<ShareLink> shares, Func<ShareLink, bool> canRevoke, DateTime now, CancellationToken ct)
    {
        var projectIds = shares.Where(s => s.ProjectId != null).Select(s => s.ProjectId!.Value).Distinct().ToList();
        var docIds = shares.Where(s => s.DocId != null).Select(s => s.DocId!.Value).Distinct().ToList();
        var userIds = shares.Select(s => s.CreatedByUserId).Distinct().ToList();
        var projects = await db.Projects.AsNoTracking().Where(p => projectIds.Contains(p.Id)).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var docs = await db.Docs.AsNoTracking().Where(d => docIds.Contains(d.Id)).ToDictionaryAsync(d => d.Id, d => d.Title, ct);
        var users = await db.Users.AsNoTracking().Where(u => userIds.Contains(u.Id)).ToDictionaryAsync(u => u.Id, u => u.PreferredName ?? u.DisplayName, ct);
        var origin = McpResource.Origin(http.Request);
        return [.. shares.Select(s => new ShareResponse(
            s.Id, s.Kind, $"{origin}/s/{secrets.Unprotect(s.ProtectedToken)}", s.OrganizationId,
            s.ProjectId, s.ProjectId is { } p ? projects.GetValueOrDefault(p) : null, s.PageUrl,
            s.DocId, s.DocId is { } d ? docs.GetValueOrDefault(d) : null,
            s.IncludeResolved, users.GetValueOrDefault(s.CreatedByUserId, "someone"), s.CreatedAt, s.ExpiresAt, !s.IsActive(now), s.ViewCount, s.LastViewedAt,
            canRevoke(s)))];
    }

    private static string Base64UrlToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static IResult Invalid(string field, string message) =>
        TypedResults.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });
}
