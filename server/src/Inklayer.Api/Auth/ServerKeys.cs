using System.Security.Cryptography;
using Inklayer.Infrastructure;
using Microsoft.IdentityModel.Tokens;

namespace Inklayer.Api.Auth;

/// <summary>
/// RSA keys that OpenIddict uses to sign and encrypt tokens. They are created on first start in <see cref="DataPaths.Keys"/>,
/// with owner-only file permissions. If they're lost, issued tokens stop working and users sign in again.
/// </summary>
internal static class ServerKeys
{
    public static RsaSecurityKey LoadOrCreate(DataPaths paths, string name)
    {
        ArgumentNullException.ThrowIfNull(paths);
        var file = Path.Combine(paths.Keys, $"{name}.pem");
        var rsa = RSA.Create();

        if (File.Exists(file))
        {
            rsa.ImportFromPem(File.ReadAllText(file));
        }
        else
        {
            rsa.KeySize = 3072;
            var pem = rsa.ExportRSAPrivateKeyPem();
            var temp = file + ".tmp";
            File.WriteAllText(temp, pem);
            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(temp, UnixFileMode.UserRead | UnixFileMode.UserWrite);
            }

            File.Move(temp, file, overwrite: false);
        }

        var keyId = Base64UrlEncoder.Encode(SHA256.HashData(rsa.ExportSubjectPublicKeyInfo()).AsSpan(0, 12).ToArray());
        return new RsaSecurityKey(rsa) { KeyId = $"{name}-{keyId}" };
    }
}
