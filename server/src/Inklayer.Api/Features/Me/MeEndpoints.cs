using Inklayer.Api.Access;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Users;
using Inklayer.Api.Auditing;
using Inklayer.Api.Auth;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Me;

internal static class MeEndpoints
{
    public static IEndpointRouteBuilder MapMeEndpoints(this IEndpointRouteBuilder app)
    {
        var me = app.MapGroup("/api/me").WithTags("Me").RequireAuthorization();

        me.MapGet("/", MeAsync).WithName("GetMe").WithSummary("The signed-in user and their organisations");
        me.MapPatch("/", UpdateAsync).WithSummary("Change the name you're shown as (empty: your real name, from your sign-in provider)");

        me.MapPost("/sessions/revoke", RevokeAllSessionsAsync)
            .WithSummary("Sign out everywhere: ends every browser session and extension token for this user");

        return app;
    }

    internal static async Task<IResult> MeAsync(CurrentUser currentUser, InklayerDbContext db, FeatureSwitches features, CancellationToken ct)
    {
        var user = await currentUser.GetAsync(ct);
        if (user is null)
        {
            return Results.Unauthorized();
        }

        var organizations = user.IsSystemAdmin
            ? await db.Organizations.OrderBy(o => o.Name).Select(o => new MyOrganization(o.Id, o.Name, Role.Owner)).ToListAsync(ct)
            : await db.OrganizationMembers.Where(m => m.UserId == user.Id)
                .Join(db.Organizations, m => m.OrganizationId, o => o.Id, (m, o) => new { o.Id, o.Name, m.Role })
                .OrderBy(x => x.Name)
                .Select(x => new MyOrganization(x.Id, x.Name, x.Role))
                .ToListAsync(ct);

        return TypedResults.Ok(new MeResponse(user.Id, user.Email, user.Name, user.AvatarUrl, user.IsSystemAdmin, organizations,
            FeaturesResponse.From(await features.StatesAsync(ct)), user.DisplayName, user.PreferredName, user.EmailNotifications));
    }

    private static async Task<IResult> UpdateAsync(UpdateMeRequest request, CurrentUser currentUser, InklayerDbContext db, FeatureSwitches features, CancellationToken ct)
    {
        var id = currentUser.Id;
        var user = id is null ? null : await db.Users.SingleOrDefaultAsync(u => u.Id == id, ct);
        if (user is null || user.IsDisabled)
        {
            return Results.Unauthorized();
        }

        // Only what's given changes. An empty name means "use my real name".
        if (request.PreferredName is not null)
        {
            var name = request.PreferredName.Trim();
            if (name.Length > User.MaxPreferredNameLength || name.Any(char.IsControl))
            {
                return TypedResults.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["preferredName"] = [$"Use at most {User.MaxPreferredNameLength} characters, without line breaks."],
                });
            }

            user.PreferredName = name.Length == 0 ? null : name;
        }

        user.EmailNotifications = request.EmailNotifications ?? user.EmailNotifications;
        await db.SaveChangesAsync(ct);
        return await MeAsync(currentUser, db, features, ct);
    }

    internal static async Task RevokeUserAccessAsync(Guid userId, InklayerDbContext db, IServiceProvider services, CancellationToken ct)
    {
        var user = await db.Users.SingleAsync(u => u.Id == userId, ct);
        user.RotateSecurityStamp();
        await db.SaveChangesAsync(ct);

        var tokens = services.GetRequiredService<OpenIddict.Abstractions.IOpenIddictTokenManager>();
        await foreach (var token in tokens.FindBySubjectAsync(userId.ToString(), ct))
        {
            await tokens.TryRevokeAsync(token, ct);
        }

        var authorizations = services.GetRequiredService<OpenIddict.Abstractions.IOpenIddictAuthorizationManager>();
        await foreach (var authorization in authorizations.FindBySubjectAsync(userId.ToString(), ct))
        {
            await authorizations.TryRevokeAsync(authorization, ct);
        }

        services.GetRequiredService<SessionGuard>().Invalidate(userId);
    }

    private static async Task<IResult> RevokeAllSessionsAsync(HttpContext context, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var userId = currentUser.Id!.Value;
        audit.Record(AuditActions.SessionsRevoked, null, "user", userId);
        await RevokeUserAccessAsync(userId, db, context.RequestServices, ct);
        await context.SignOutAsync(AuthSchemes.Cookie);
        return Results.NoContent();
    }
}

internal sealed record MyOrganization(Guid Id, string Name, Role Role);

/// <param name="DisplayName">The name they're shown as: their chosen name, or their real name.</param>
/// <param name="Features">Which major features are on (docs, live cursors, AI assistants).</param>
/// <param name="FullName">Their real name, from their sign-in provider.</param>
/// <param name="PreferredName">The name they chose, if any.</param>
internal sealed record MeResponse(
    Guid Id, string Email, string DisplayName, string? AvatarUrl, bool IsSystemAdmin, IReadOnlyList<MyOrganization> Organizations, FeaturesResponse Features,
    string FullName, string? PreferredName, bool EmailNotifications);

/// <param name="PreferredName">The name to be shown as; empty for your real name; null (or left out) to keep it.</param>
/// <param name="EmailNotifications">Email me my notifications (when my organisation sends emails).</param>
internal sealed record UpdateMeRequest(string? PreferredName, bool? EmailNotifications = null);
