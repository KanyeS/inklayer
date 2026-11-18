using Inklayer.Api.Auth;
using Inklayer.Domain.Users;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Access;

/// <summary>The signed-in user for this request, from either the session cookie or a bearer token. Scoped per request.</summary>
public sealed class CurrentUser(IHttpContextAccessor http, InklayerDbContext db)
{
    private User? _user;

    public Guid? Id =>
        http.HttpContext?.User.FindFirst(InklayerClaims.Subject)?.Value is { } sub && Guid.TryParse(sub, out var id) ? id : null;

    /// <summary>Loads the user record (once per request). It is null when anonymous or the account no longer exists.</summary>
    public async Task<User?> GetAsync(CancellationToken cancellationToken)
    {
        if (_user is null && Id is { } id)
        {
            _user = await db.Users.AsNoTracking().SingleOrDefaultAsync(u => u.Id == id, cancellationToken);
        }

        return _user;
    }
}
