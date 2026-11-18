using Inklayer.Domain.Notifications;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Notifications;

/// <summary>The people @mentioned in some text, so apps can show <c>&lt;@id&gt;</c> as their names.</summary>
internal static class MentionedPeople
{
    public static async Task<List<PersonResponse>> ForAsync(InklayerDbContext db, IEnumerable<string?> texts, CancellationToken ct)
    {
        var ids = texts.SelectMany(t => Mentions.Extract(t)).Distinct().ToList();
        if (ids.Count == 0)
        {
            return [];
        }

        return await db.Users.AsNoTracking().Where(u => ids.Contains(u.Id))
            .Select(u => new PersonResponse(u.Id, u.PreferredName ?? u.DisplayName, u.DisplayName)).ToListAsync(ct);
    }
}
