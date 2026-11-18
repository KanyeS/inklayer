using System.Buffers;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Inklayer.Infrastructure.Storage;

public enum BlobWriteResult
{
    Created,
    AlreadyExists,
    HashMismatch,
    TooLarge,
}

/// <summary>
/// Stores immutable blobs on disk under their lower-case hex SHA-256 hash: <c>blobs/ab/cd/abcd…</c>.
/// <list type="bullet">
/// <item>Uploads are written to a temp file while being hashed, then moved into place atomically, so a partial or forged upload never becomes visible.</item>
/// <item>A blob is stored once, however many snapshots or organisations reference it.</item>
/// </list>
/// </summary>
public sealed partial class BlobStore(DataPaths paths)
{
    public static bool IsValidHash(string? hash) => hash is not null && HashPattern().IsMatch(hash);

    public bool Exists(string hash) => IsValidHash(hash) && File.Exists(PathFor(hash));

    public long? GetSize(string hash) => Exists(hash) ? new FileInfo(PathFor(hash)).Length : null;

    /// <summary>Opens a blob for reading, or returns null if it doesn't exist.</summary>
    public Stream? OpenRead(string hash) =>
        Exists(hash) ? new FileStream(PathFor(hash), FileMode.Open, FileAccess.Read, FileShare.Read, 81920, useAsync: true) : null;

    public async Task<BlobWriteResult> WriteAsync(string expectedHash, Stream content, long maxBytes, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(content);
        if (!IsValidHash(expectedHash))
        {
            return BlobWriteResult.HashMismatch;
        }

        var target = PathFor(expectedHash);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        var temp = Path.Combine(Path.GetDirectoryName(target)!, $".{expectedHash}.{Guid.NewGuid():N}.tmp");

        try
        {
            string actualHash;
            await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, useAsync: true))
            using (var sha = IncrementalHash.CreateHash(HashAlgorithmName.SHA256))
            {
                var buffer = ArrayPool<byte>.Shared.Rent(81920);
                try
                {
                    long total = 0;
                    int read;
                    while ((read = await content.ReadAsync(buffer, cancellationToken)) > 0)
                    {
                        total += read;
                        if (total > maxBytes)
                        {
                            return BlobWriteResult.TooLarge;
                        }

                        sha.AppendData(buffer, 0, read);
                        await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                    }
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(buffer);
                }

                actualHash = Convert.ToHexStringLower(sha.GetHashAndReset());
            }

            if (!string.Equals(actualHash, expectedHash, StringComparison.Ordinal))
            {
                return BlobWriteResult.HashMismatch;
            }

            if (File.Exists(target))
            {
                return BlobWriteResult.AlreadyExists;
            }

            File.Move(temp, target, overwrite: false);
            return BlobWriteResult.Created;
        }
        catch (IOException) when (File.Exists(target))
        {
            // Another request stored the same blob at the same moment. The content is identical, so that's fine.
            return BlobWriteResult.AlreadyExists;
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    /// <summary>Stores bytes produced by the server itself (for example sanitized HTML) and returns their hash.</summary>
    public async Task<string> WriteAsync(byte[] content, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(content);
        var hash = Convert.ToHexStringLower(SHA256.HashData(content));
        using var stream = new MemoryStream(content, writable: false);
        await WriteAsync(hash, stream, long.MaxValue, cancellationToken);
        return hash;
    }

    private string PathFor(string hash) => Path.Combine(paths.Blobs, hash[..2], hash[2..4], hash);

    [GeneratedRegex("^[0-9a-f]{64}$")]
    private static partial Regex HashPattern();
}
