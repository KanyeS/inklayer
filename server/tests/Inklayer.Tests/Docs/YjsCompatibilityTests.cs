using Inklayer.Api.Features.Docs;

namespace Inklayer.Tests.Docs;

/// <summary>The server edits docs with YDotNet (yrs); the browser with Yjs. Their updates must be interchangeable.</summary>
public sealed class YjsCompatibilityTests
{
    /// <summary>Made by Yjs 13 in the browser's code: "# Héllo 👋 world\nSecond line [[Roadmap]]", then "H" deleted.</summary>
    public const string FromYjs = "AQOSIQAEAQdjb250ZW50AiMggZIhAQGEkiECKMOpbGxvIPCfkYsgd29ybGQKU2Vjb25kIGxpbmUgW1tSb2FkbWFwXV0BkiEBAgE=";

    [Fact]
    public void Updates_from_the_browser_load_on_the_server()
    {
        using var doc = DocText.Load(Convert.FromBase64String(FromYjs), []);
        Assert.Equal("# éllo 👋 world\nSecond line [[Roadmap]]", DocText.TextOf(doc));
    }

    [Fact]
    public void Offsets_are_counted_like_javascript()
    {
        using var doc = DocText.Load(Convert.FromBase64String(FromYjs), []);
        var text = doc.Text("content");
        var at = "# éllo 👋".Length; // UTF-16: the emoji counts as 2, as in JavaScript
        using (var write = doc.WriteTransaction())
        {
            text.Insert(write, (uint)at, "!");
            write.Commit();
        }

        Assert.Equal("# éllo 👋! world\nSecond line [[Roadmap]]", DocText.TextOf(doc));
    }
}
