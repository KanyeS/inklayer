namespace Inklayer.Infrastructure;

/// <summary>
/// Where Inklayer keeps files on disk. By default everything lives next to the SQLite database
/// (in Docker, the <c>/data</c> volume).
/// </summary>
public sealed class DataPaths(string root)
{
    public string Root { get; } = root;

    /// <summary>Token-signing and Data Protection keys. These files aren't in the Litestream backup; losing them only signs everyone out.</summary>
    public string Keys => Path.Combine(Root, "keys");

    /// <summary>Content-addressed blobs (snapshot HTML, assets, screenshots), in <c>blobs/ab/cd/abcd…</c> form.</summary>
    public string Blobs => Path.Combine(Root, "blobs");
}
