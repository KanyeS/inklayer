using System.Text.Json;
using Inklayer.Api.Access;
using Inklayer.Domain.Auditing;
using Inklayer.Infrastructure.Persistence;

namespace Inklayer.Api.Auditing;

/// <summary>
/// Adds audit events to the current unit of work, so they are saved in the same transaction as the change they describe.
/// The caller must call <c>SaveChangesAsync</c>.
/// </summary>
public sealed class AuditLog(InklayerDbContext db, CurrentUser currentUser, IHttpContextAccessor http, TimeProvider clock)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    public void Record(string action, Guid? organizationId, string? targetType, Guid targetId, object? data = null, Guid? actorUserId = null) =>
        Record(action, organizationId, targetType, targetId.ToString(), data, actorUserId);

    public void Record(string action, Guid? organizationId, string? targetType, string? targetId, object? data = null, Guid? actorUserId = null)
    {
        db.AuditEvents.Add(new AuditEvent
        {
            OccurredAt = clock.GetUtcNow().UtcDateTime,
            ActorUserId = actorUserId ?? currentUser.Id,
            OrganizationId = organizationId,
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Data = data is null ? null : JsonSerializer.Serialize(data, JsonOptions),
            IpAddress = http.HttpContext?.Connection.RemoteIpAddress?.ToString(),
        });
    }
}
