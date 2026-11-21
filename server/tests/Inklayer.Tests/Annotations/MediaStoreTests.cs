using Inklayer.Api.Features.Media;
using Inklayer.Infrastructure;
using Microsoft.Extensions.Options;

namespace Inklayer.Tests.Annotations;

/// <summary>
/// Files kept on disk (no S3 bucket) are read as they're sent, parts included. A video player's first request asks for
/// "bytes=0-", the whole file: copying that into memory let two people playing a 40 MB recording run the server out of it.
/// </summary>
public sealed class MediaStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"inklayer-media-{Guid.NewGuid():N}");
    private readonly DiskMediaStore _store;
    private readonly byte[] _video = [.. Enumerable.Range(0, 3 * 1024 * 1024).Select(i => (byte)(i % 251))];

    public MediaStoreTests()
    {
        _store = new DiskMediaStore(Options.Create(new MediaOptions()), new DataPaths(_root));
    }

    public void Dispose() => Directory.Delete(_root, recursive: true);

    private async Task<byte[]> ReadAsync(long? from, long? to)
    {
        await using var file = (await _store.GetAsync("c/video.webm", from, to, CancellationToken.None))!;
        Assert.Equal(_video.Length, file.Length);
        Assert.IsNotType<MemoryStream>(file.Content);
        using var read = new MemoryStream();
        await file.Content.CopyToAsync(read);
        return read.ToArray();
    }

    [Fact]
    public async Task Parts_are_read_from_the_file_as_they_are_sent()
    {
        using (var upload = new MemoryStream(_video))
        {
            await _store.PutAsync("c/video.webm", upload, "video/webm", CancellationToken.None);
        }

        Assert.Equal(_video, await ReadAsync(null, null));
        Assert.Equal(_video, await ReadAsync(0, _video.Length - 1));
        Assert.Equal(_video[1_000_000..], await ReadAsync(1_000_000, _video.Length - 1));
        Assert.Equal(_video[10..20], await ReadAsync(10, 19));
        Assert.Equal(_video[^1..], await ReadAsync(_video.Length - 1, _video.Length - 1));
    }

    [Fact]
    public async Task A_part_stops_at_its_end_and_closes_the_file()
    {
        var path = Path.Combine(_root, "part.bin");
        Directory.CreateDirectory(_root);
        await File.WriteAllBytesAsync(path, _video);
        var file = File.OpenRead(path);
        file.Seek(100, SeekOrigin.Begin);

        await using (var part = new PartStream(file, 50))
        {
            var buffer = new byte[200];
            var read = await part.ReadAsync(buffer);
            Assert.Equal(50, read);
            Assert.Equal(_video[100..150], buffer[..50]);
            Assert.Equal(0, await part.ReadAsync(buffer));
            Assert.Equal(50, part.Length);
        }

        // Closed with the part: the file can be deleted (it couldn't be while open on Windows; on Linux reading throws).
        Assert.Throws<ObjectDisposedException>(() => file.ReadByte());
    }
}
