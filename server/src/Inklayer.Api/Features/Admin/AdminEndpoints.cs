using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Api.Features.Me;
using Inklayer.Api.Network;
using Inklayer.Domain.Auditing;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Admin;

public sealed record AdminUserResponse(Guid Id, string Email, string DisplayName, bool IsSystemAdmin, bool IsDisabled, DateTime CreatedAt, DateTime LastSignInAt);

/// <summary>Instance-wide user management for instance administrators.</summary>
internal static class AdminEndpoints
{
    public static IEndpointRouteBuilder MapAdminEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/api/admin").WithTags("Admin").RequireAuthorization()
            .AddEndpointFilter(async (context, next) =>
            {
                var user = await context.HttpContext.RequestServices.GetRequiredService<CurrentUser>().GetAsync(context.HttpContext.RequestAborted);
                return user is { IsSystemAdmin: true, IsDisabled: false }
                    ? await next(context)
                    : TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Instance administrators only.");
            });

        admin.MapNetworkEndpoints();

        admin.MapGet("/users", async (InklayerDbContext db, CancellationToken ct) =>
            TypedResults.Ok(await db.Users.AsNoTracking().OrderBy(u => u.Email)
                .Select(u => new AdminUserResponse(u.Id, u.Email, u.DisplayName, u.IsSystemAdmin, u.IsDisabled, u.CreatedAt, u.LastSignInAt))
                .ToListAsync(ct)));

        admin.MapPost("/users/{userId:guid}/disable", async (Guid userId, HttpContext context, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct) =>
        {
            if (userId == currentUser.Id)
            {
                return Results.Problem(statusCode: StatusCodes.Status409Conflict, title: "You can't disable your own account.");
            }

            var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null)
            {
                return Results.NotFound();
            }

            user.IsDisabled = true;
            audit.Record(AuditActions.UserDisabled, null, "user", userId, new { user.Email });
            await db.SaveChangesAsync(ct);
            await MeEndpoints.RevokeUserAccessAsync(userId, db, context.RequestServices, ct);
            return Results.NoContent();
        }).WithSummary("Disable a user and immediately end all their sessions and extension tokens");

        admin.MapPost("/users/{userId:guid}/enable", async (Guid userId, InklayerDbContext db, AuditLog audit, Auth.SessionGuard guard, CancellationToken ct) =>
        {
            var user = await db.Users.SingleOrDefaultAsync(u => u.Id == userId, ct);
            if (user is null)
            {
                return Results.NotFound();
            }

            user.IsDisabled = false;
            audit.Record(AuditActions.UserEnabled, null, "user", userId, new { user.Email });
            await db.SaveChangesAsync(ct);
            guard.Invalidate(userId);
            return Results.NoContent();
        });

        return app;
    }
}
