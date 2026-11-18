using Inklayer.Api.Access;
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

        me.MapGet("/", async (CurrentUser currentUser, InklayerDbContext db, CancellationToken ct) =>
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

            return Results.Ok(new MeResponse(user.Id, user.Email, user.DisplayName, user.AvatarUrl, user.IsSystemAdmin, organizations));
        }).WithName("GetMe").WithSummary("The signed-in user and their organisations");

        me.MapPost("/sessions/revoke", RevokeAllSessionsAsync)
            .WithSummary("Sign out everywhere: ends every browser session and extension token for this user");

        return app;
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

internal sealed record MeResponse(Guid Id, string Email, string DisplayName, string? AvatarUrl, bool IsSystemAdmin, IReadOnlyList<MyOrganization> Organizations);
