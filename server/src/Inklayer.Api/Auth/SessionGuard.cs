using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Inklayer.Api.Auth;

/// <summary>
/// Rejects session cookies whose user is disabled or whose security stamp has changed (for example after
/// "sign out everywhere"). Results are cached briefly; <see cref="Invalidate"/> makes a change apply immediately.
/// </summary>
public sealed class SessionGuard(IMemoryCache cache)
{
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(30);

    private sealed record Snapshot(string Stamp, bool Disabled);

    public void Invalidate(Guid userId) => cache.Remove(CacheKey(userId));

    internal async Task<bool> IsValidAsync(Guid userId, string? stamp, InklayerDbContext db, CancellationToken cancellationToken)
    {
        var snapshot = await cache.GetOrCreateAsync(CacheKey(userId), async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = CacheFor;
            return await db.Users.Where(u => u.Id == userId)
                .Select(u => new Snapshot(u.SecurityStamp, u.IsDisabled))
                .SingleOrDefaultAsync(cancellationToken);
        });

        return snapshot is { Disabled: false } && string.Equals(snapshot.Stamp, stamp, StringComparison.Ordinal);
    }

    internal static async Task ValidatePrincipalAsync(CookieValidatePrincipalContext context)
    {
        var principal = context.Principal;
        var services = context.HttpContext.RequestServices;
        var valid = principal?.FindFirst(InklayerClaims.Subject)?.Value is { } sub
            && Guid.TryParse(sub, out var userId)
            && await services.GetRequiredService<SessionGuard>().IsValidAsync(
                userId,
                principal.FindFirst(InklayerClaims.SecurityStamp)?.Value,
                services.GetRequiredService<InklayerDbContext>(),
                context.HttpContext.RequestAborted);

        if (!valid)
        {
            context.RejectPrincipal();
            await context.HttpContext.SignOutAsync(AuthSchemes.Cookie);
        }
    }

    private static string CacheKey(Guid userId) => $"session-guard:{userId}";
}
