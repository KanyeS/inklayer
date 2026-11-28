using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Api.Auth;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Issues;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <param name="CallbackUrl">The callback (redirect) URL to register in the tracker's OAuth app.</param>
/// <param name="Url">The instance, for GitHub, GitLab and Forgejo. Shown for every source.</param>
/// <param name="TenantId">The Entra tenant, for Azure DevOps.</param>
/// <param name="Accounts">How many people have connected their own account through it.</param>
/// <param name="NeedsSecret">Its client secret can't be decrypted (the database was restored without the server's keys): enter it again.</param>
public sealed record TrackerAppResponse(
    [property: AllowedValues(TrackerKinds.GitHub, TrackerKinds.Jira, TrackerKinds.Linear, TrackerKinds.AzureDevOps, TrackerKinds.GitLab, TrackerKinds.Forgejo)] string Kind,
    string Name, TrackerAppSource Source, string CallbackUrl, int Accounts,
    string? ClientId = null, bool HasClientSecret = false, string? Url = null, string? TenantId = null, bool NeedsSecret = false);

/// <param name="ClientSecret">On a change, leave it out (or null) to keep the current secret.</param>
/// <param name="Url">GitHub: a GitHub Enterprise Server, else github.com. GitLab: a self-managed GitLab, else gitlab.com. Forgejo: the instance, else Codeberg.</param>
/// <param name="TenantId">Azure DevOps: the Entra tenant (directory) id, else <c>organizations</c> (any work or school account).</param>
public sealed record SaveTrackerAppRequest(
    [property: Required, MaxLength(500)] string? ClientId,
    [property: MaxLength(2000)] string? ClientSecret,
    [property: MaxLength(500)] string? Url,
    [property: MaxLength(100)] string? TenantId);

/// <summary>
/// Instance administrators set up the OAuth apps people connect their own tracker accounts through, without editing the
/// server's configuration or restarting it (mapped under the admin-only group).
/// </summary>
internal static class TrackerAppEndpoints
{
    public static RouteGroupBuilder MapTrackerAppEndpoints(this RouteGroupBuilder admin)
    {
        admin.MapGet("/tracker-apps", async (HttpContext http, TrackerOAuthApps apps, InklayerDbContext db, CancellationToken ct) =>
            TypedResults.Ok(await ListAsync(http, apps, db, ct)))
            .WithSummary("The OAuth apps people connect their own tracker accounts through: from the server's configuration, or added here");

        admin.MapPut("/tracker-apps/{kind}", async (string kind, SaveTrackerAppRequest request, HttpContext http, TrackerOAuthApps apps,
            SignInProviderSettings settings, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct) =>
        {
            if (Refusal(kind, apps) is { } refusal)
            {
                return refusal;
            }

            var existing = apps.Added.FirstOrDefault(a => a.Kind == kind);
            var secret = string.IsNullOrWhiteSpace(request.ClientSecret) ? null : request.ClientSecret.Trim();
            if (secret is null && (existing?.ProtectedClientSecret is null || apps.NeedsSecret(kind)))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["clientSecret"] = [existing is null ? "Enter the app's client secret." : "The saved secret can't be read on this server any more. Enter it again."],
                });
            }

            var clientId = request.ClientId!.Trim();
            var url = HasInstance(kind) && !string.IsNullOrWhiteSpace(request.Url) ? request.Url.Trim().TrimEnd('/') : null;
            if (url is not null && !ValidUrl(url, settings.AllowInsecureHttp))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["url"] = ["Enter the instance's address, starting with https://."] });
            }

            var tenantId = kind == TrackerKinds.AzureDevOps && !string.IsNullOrWhiteSpace(request.TenantId) ? request.TenantId.Trim() : null;

            // The tracker's usual instance or tenant is kept as "none given", so writing it out doesn't count as a change.
            if (url is not null && string.Equals(url, DefaultInstance(kind), StringComparison.OrdinalIgnoreCase))
            {
                url = null;
            }

            if (string.Equals(tenantId, "organizations", StringComparison.OrdinalIgnoreCase))
            {
                tenantId = null;
            }

            // Accounts connected through a different app (or on another instance) can't be refreshed through this one.
            var disconnected = existing is not null && (existing.ClientId != clientId || existing.Url != url || existing.TenantId != tenantId)
                ? await DisconnectAllAsync(kind, db, ct)
                : 0;

            await apps.SaveAsync(kind, clientId, secret, url, tenantId, currentUser.Id!.Value, ct);
            audit.Record(AuditActions.TrackerAppSaved, null, "tracker_app", kind, new { ClientId = clientId, Url = url, TenantId = tenantId, Disconnected = disconnected });
            await db.SaveChangesAsync(ct);
            return Results.Ok(await ListAsync(http, apps, db, ct));
        }).Produces<List<TrackerAppResponse>>()
            .WithSummary("Set up or change a tracker's OAuth app. Leave out the client secret to keep it. Changing the app or its instance disconnects the accounts connected through it.");

        admin.MapDelete("/tracker-apps/{kind}", async (string kind, HttpContext http, TrackerOAuthApps apps,
            CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct) =>
        {
            if (Refusal(kind, apps) is { } refusal)
            {
                return refusal;
            }

            if (apps.Source(kind) != TrackerAppSource.Admin)
            {
                return Results.NotFound();
            }

            var disconnected = await DisconnectAllAsync(kind, db, ct);
            await apps.RemoveAsync(kind, currentUser.Id!.Value, ct);
            audit.Record(AuditActions.TrackerAppRemoved, null, "tracker_app", kind, new { Disconnected = disconnected });
            await db.SaveChangesAsync(ct);
            return Results.Ok(await ListAsync(http, apps, db, ct));
        }).Produces<List<TrackerAppResponse>>().WithSummary("Remove a tracker's OAuth app added here, and disconnect the accounts connected through it");

        return admin;
    }

    private static IResult? Refusal(string kind, TrackerOAuthApps apps) =>
        !TrackerAccounts.Kinds.Contains(kind) ? Results.NotFound()
        : apps.Source(kind) == TrackerAppSource.Config
            ? Results.Problem(statusCode: StatusCodes.Status409Conflict,
                title: "This tracker's app is set in the server's configuration. Change it there and restart the server.")
            : null;

    private static string? DefaultInstance(string kind) => kind switch
    {
        TrackerKinds.GitHub => "https://github.com",
        TrackerKinds.GitLab => "https://gitlab.com",
        TrackerKinds.Forgejo => "https://codeberg.org",
        _ => null,
    };

    private static bool HasInstance(string kind) => kind is TrackerKinds.GitHub or TrackerKinds.GitLab or TrackerKinds.Forgejo;

    private static bool ValidUrl(string url, bool allowHttp) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || (allowHttp && u.Scheme == Uri.UriSchemeHttp))
        && string.IsNullOrEmpty(u.Query) && string.IsNullOrEmpty(u.Fragment);

    private static async Task<int> DisconnectAllAsync(string kind, InklayerDbContext db, CancellationToken ct) =>
        await db.TrackerAccounts.Where(a => a.Kind == kind).ExecuteDeleteAsync(ct);

    private static async Task<List<TrackerAppResponse>> ListAsync(HttpContext http, TrackerOAuthApps apps, InklayerDbContext db, CancellationToken ct)
    {
        var accounts = await db.TrackerAccounts.AsNoTracking().GroupBy(a => a.Kind).Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.Key, g => g.Count, ct);
        var current = apps.Current;
        return [.. TrackerAccounts.Kinds.Select(kind =>
        {
            var source = apps.Source(kind);
            var callback = TrackerAccountEndpoints.CallbackUrl(http, kind);
            var count = accounts.GetValueOrDefault(kind);
            var url = kind switch
            {
                TrackerKinds.GitHub => current.GitHub.WebUrl,
                TrackerKinds.GitLab => current.GitLab.Url,
                TrackerKinds.Forgejo => current.Forgejo.Url,
                _ => null,
            };
            var tenant = kind == TrackerKinds.AzureDevOps ? current.AzureDevOps.TenantId : null;
            var added = apps.Added.FirstOrDefault(a => a.Kind == kind);
            return source switch
            {
                TrackerAppSource.Admin => new TrackerAppResponse(kind, TrackerKinds.Name(kind), source, callback, count,
                    added!.ClientId, added.ProtectedClientSecret is not null, url is null ? null : added.Url ?? url, tenant is null ? null : added.TenantId ?? tenant, apps.NeedsSecret(kind)),
                TrackerAppSource.Config => new TrackerAppResponse(kind, TrackerKinds.Name(kind), source, callback, count, Url: url, TenantId: tenant),
                _ => new TrackerAppResponse(kind, TrackerKinds.Name(kind), source, callback, count),
            };
        })];
    }
}
