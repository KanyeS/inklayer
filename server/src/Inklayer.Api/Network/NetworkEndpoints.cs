using System.ComponentModel.DataAnnotations;
using System.Net;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Network;
using Inklayer.Domain.Settings;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Network;

/// <param name="AllowedNetworks">The list in force. Empty: every network is allowed.</param>
/// <param name="Source">Where it comes from: nowhere, the server's configuration, or an administrator.</param>
/// <param name="RestrictionDisabled">The server's configuration turns the restriction off, whatever the list says.</param>
/// <param name="YourAddress">The caller's address as the server sees it, so admins know what to add.</param>
public sealed record NetworkAccessResponse(
    IReadOnlyList<string> AllowedNetworks, NetworkListSource Source, bool RestrictionDisabled, string? YourAddress, bool YourAddressAllowed);

public sealed record UpdateNetworkAccessRequest([property: Required] List<string>? AllowedNetworks);

/// <summary>Instance administrators view and change the networks Inklayer answers from (mapped under the admin-only group).</summary>
internal static class NetworkEndpoints
{
    public static RouteGroupBuilder MapNetworkEndpoints(this RouteGroupBuilder admin)
    {
        admin.MapGet("/network", async (HttpContext context, NetworkAccess access, CancellationToken ct) =>
        {
            var (list, source) = await access.CurrentAsync(ct);
            return TypedResults.Ok(ToResponse(list, source, access, context));
        }).WithSummary("The networks (e.g. VPN ranges) Inklayer answers requests from");

        admin.MapPut("/network", async (UpdateNetworkAccessRequest request, HttpContext context, NetworkAccess access, CurrentUser currentUser,
            InklayerDbContext db, AuditLog audit, TimeProvider clock, CancellationToken ct) =>
        {
            if (IpAllowList.TryParse(request.AllowedNetworks!, out var errors) is not { } list)
            {
                return Results.ValidationProblem(new Dictionary<string, string[]> { ["allowedNetworks"] = [.. errors] });
            }

            // Saving a list without your own address would cut you off on the next request.
            var address = context.Connection.RemoteIpAddress;
            if (!access.RestrictionDisabled && !NetworkAccess.IsAlwaysAllowed(context) && !list.Allows(address))
            {
                return Results.Problem(statusCode: StatusCodes.Status409Conflict,
                    title: $"This list doesn't include your current address ({Shown(address)}), so saving it would lock you out. Add it, or save from a network that's on the list.");
            }

            var setting = await db.InstanceSettings.SingleOrDefaultAsync(s => s.Key == InstanceSetting.AllowedNetworks, ct);
            if (setting is null)
            {
                setting = new InstanceSetting { Key = InstanceSetting.AllowedNetworks, Value = "" };
                db.InstanceSettings.Add(setting);
            }

            setting.Value = string.Join('\n', list.Entries);
            setting.UpdatedAt = clock.GetUtcNow().UtcDateTime;
            setting.UpdatedByUserId = currentUser.Id;
            audit.Record(AuditActions.NetworkAccessChanged, null, "instance", (string?)null, new { allowedNetworks = list.Entries });
            await db.SaveChangesAsync(ct);
            access.Save(list);
            return Results.Ok(ToResponse(list, NetworkListSource.Admin, access, context));
        }).WithSummary("Replace the allowed networks. An empty list allows every network.");

        return admin;
    }

    private static NetworkAccessResponse ToResponse(IpAllowList list, NetworkListSource source, NetworkAccess access, HttpContext context)
    {
        var address = context.Connection.RemoteIpAddress;
        return new NetworkAccessResponse(list.Entries, source, access.RestrictionDisabled, address is null ? null : Shown(address),
            list.Allows(address) || NetworkAccess.IsAlwaysAllowed(context));
    }

    private static string Shown(IPAddress? address) => address is null ? "unknown" : IpAllowList.Normalize(address).ToString();
}
