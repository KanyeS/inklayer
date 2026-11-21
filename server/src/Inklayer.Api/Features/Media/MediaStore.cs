using System.Net;
using Amazon;
using Amazon.S3;
using Amazon.S3.Model;
using Inklayer.Infrastructure;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Media;

/// <summary>
/// Where large files captured with comments (full-page screenshots, videos) are kept, under <c>Inklayer:Media</c>:
/// an S3 bucket (<c>S3Bucket</c>, <c>S3Region</c>, <c>S3Prefix</c>; credentials from the usual AWS settings, such as
/// <c>AWS_ACCESS_KEY_ID</c>), or without one, a folder (<c>Path</c>, by default <c>media</c> next to the database).
/// </summary>
public sealed class MediaOptions
{
    public const string SectionName = "Inklayer:Media";

    public string S3Bucket { get; set; } = "";

    public string S3Region { get; set; } = "";

    /// <summary>Keys start with this, so the bucket can hold other things too (the database backups).</summary>
    public string S3Prefix { get; set; } = "media/";

    public string Path { get; set; } = "";
}

/// <summary>A stored file, opened for reading. <see cref="Length"/> is the whole file's, even when only a part was asked for.</summary>
internal sealed record MediaFile(Stream Content, long Length, string ContentType) : IAsyncDisposable
{
    public ValueTask DisposeAsync() => Content.DisposeAsync();
}

internal interface IMediaStore
{
    /// <summary>Stores a file from a seekable stream, replacing any at <paramref name="key"/>.</summary>
    Task PutAsync(string key, Stream content, string contentType, CancellationToken ct);

    /// <summary>The file, or the bytes from <paramref name="from"/> to <paramref name="to"/> (inclusive); null if there's none.</summary>
    Task<MediaFile?> GetAsync(string key, long? from, long? to, CancellationToken ct);

    Task DeleteAsync(string key, CancellationToken ct);
}

/// <summary>Files in an S3 bucket. The server reads them and passes them on, so people never download from S3 itself.</summary>
internal sealed class S3MediaStore(IOptions<MediaOptions> options) : IMediaStore, IDisposable
{
    private readonly AmazonS3Client s3 = new(new AmazonS3Config { RegionEndpoint = RegionEndpoint.GetBySystemName(options.Value.S3Region) });

    private string Bucket => options.Value.S3Bucket;

    private string Key(string key) => options.Value.S3Prefix + key;

    public async Task PutAsync(string key, Stream content, string contentType, CancellationToken ct) =>
        await s3.PutObjectAsync(new PutObjectRequest { BucketName = Bucket, Key = Key(key), InputStream = content, ContentType = contentType, AutoCloseStream = false }, ct);

    public async Task<MediaFile?> GetAsync(string key, long? from, long? to, CancellationToken ct)
    {
        var request = new GetObjectRequest { BucketName = Bucket, Key = Key(key) };
        if (from is { } start)
        {
            request.ByteRange = to is { } end ? new ByteRange(start, end) : new ByteRange($"bytes={start}-");
        }

        try
        {
            var response = await s3.GetObjectAsync(request, ct);
            var total = response.ContentRange is { } range && range.Split('/') is [_, var size] && long.TryParse(size, out var whole) ? whole : response.ContentLength;
            return new MediaFile(response.ResponseStream, total, response.Headers.ContentType ?? "application/octet-stream");
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task DeleteAsync(string key, CancellationToken ct) =>
        await s3.DeleteObjectAsync(new DeleteObjectRequest { BucketName = Bucket, Key = Key(key) }, ct);

    public void Dispose() => s3.Dispose();
}

/// <summary>Files in a folder: for servers without a bucket, and for development and tests.</summary>
internal sealed class DiskMediaStore(IOptions<MediaOptions> options, DataPaths paths) : IMediaStore
{
    private string Root => options.Value.Path is { Length: > 0 } path ? path : System.IO.Path.Combine(paths.Root, "media");

    /// <summary>Keys are made by Inklayer (ids and kinds); this keeps any other from leaving the folder.</summary>
    private string FileOf(string key)
    {
        var root = System.IO.Path.GetFullPath(Root);
        var file = System.IO.Path.GetFullPath(System.IO.Path.Combine(root, key));
        return file.StartsWith(root + System.IO.Path.DirectorySeparatorChar, StringComparison.Ordinal) ? file : throw new ArgumentException("Bad media key.", nameof(key));
    }

    public async Task PutAsync(string key, Stream content, string contentType, CancellationToken ct)
    {
        var file = FileOf(key);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(file)!);
        await using (var output = File.Create(file))
        {
            await content.CopyToAsync(output, ct);
        }

        await File.WriteAllTextAsync(file + ".type", contentType, ct);
    }

    public async Task<MediaFile?> GetAsync(string key, long? from, long? to, CancellationToken ct)
    {
        var file = FileOf(key);
        if (!File.Exists(file))
        {
            return null;
        }

        var type = File.Exists(file + ".type") ? await File.ReadAllTextAsync(file + ".type", ct) : "application/octet-stream";
        var stream = File.OpenRead(file);
        var length = stream.Length;
        if (from is not { } start)
        {
            return new MediaFile(stream, length, type);
        }

        // Read from the file as it's sent, never copied into memory: a video player's first request ("bytes=0-") is the
        // whole file, up to 40 MB, and two at once used to run the server out of memory.
        stream.Seek(start, SeekOrigin.Begin);
        var count = (to ?? (length - 1)) - start + 1;
        return new MediaFile(new PartStream(stream, count), length, type);
    }

    public Task DeleteAsync(string key, CancellationToken ct)
    {
        var file = FileOf(key);
        File.Delete(file);
        File.Delete(file + ".type");
        return Task.CompletedTask;
    }
}

/// <summary>Reads at most <c>count</c> bytes of a stream from where it is now, then ends. Disposes the stream with it.</summary>
internal sealed class PartStream(Stream inner, long count) : Stream
{
    private readonly long _length = count;
    private long _left = count;

    public override bool CanRead => true;

    public override bool CanSeek => false;

    public override bool CanWrite => false;

    public override long Length => _length;

    public override long Position
    {
        get => _length - _left;
        set => throw new NotSupportedException();
    }

    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

    public override int Read(Span<byte> buffer)
    {
        if (_left <= 0)
        {
            return 0;
        }

        var read = inner.Read(buffer[..(int)Math.Min(buffer.Length, _left)]);
        _left -= read;
        return read;
    }

    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (_left <= 0)
        {
            return 0;
        }

        var read = await inner.ReadAsync(buffer[..(int)Math.Min(buffer.Length, _left)], cancellationToken);
        _left -= read;
        return read;
    }

    public override void Flush()
    {
    }

    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            inner.Dispose();
        }

        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await inner.DisposeAsync();
        await base.DisposeAsync();
    }
}

internal static class MediaSetup
{
    public static IServiceCollection AddInklayerMedia(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<MediaOptions>().BindConfiguration(MediaOptions.SectionName);
        if (configuration[$"{MediaOptions.SectionName}:S3Bucket"] is { Length: > 0 })
        {
            services.AddSingleton<IMediaStore, S3MediaStore>();
        }
        else
        {
            services.AddSingleton<IMediaStore, DiskMediaStore>();
        }

        return services;
    }
}
