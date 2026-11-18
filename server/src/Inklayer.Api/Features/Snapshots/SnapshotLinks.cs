using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Snapshots;

/// <summary>
/// Issues and checks the signed, expiring links that snapshot pages are served under:
/// <c>{origin}/s/{snapshotId}/{token}/</c>. Assets are relative (<c>a/{hash}</c>), so they inherit the same token.
/// </summary>
public sealed class SnapshotLinks(IDataProtectionProvider dataProtection, IOptions<SnapshotOptions> options, TimeProvider clock)
{
    private readonly ITimeLimitedDataProtector _protector =
        dataProtection.CreateProtector("inklayer.snapshot-view.v1").ToTimeLimitedDataProtector();

    public Uri? CreateViewUrl(Guid snapshotId)
    {
        var origin = options.Value.OriginUri;
        if (origin is null)
        {
            return null;
        }

        var expires = clock.GetUtcNow().AddMinutes(options.Value.ViewLinkLifetimeMinutes);
        var token = _protector.Protect(snapshotId.ToString("N"), expires);
        return new Uri(origin, $"/s/{snapshotId}/{token}/");
    }

    public bool IsValid(Guid snapshotId, string token)
    {
        try
        {
            return _protector.Unprotect(token, out var expiration) == snapshotId.ToString("N") && expiration > clock.GetUtcNow();
        }
        catch (System.Security.Cryptography.CryptographicException)
        {
            return false;
        }
    }
}
