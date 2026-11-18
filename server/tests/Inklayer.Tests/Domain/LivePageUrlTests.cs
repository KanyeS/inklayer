using Inklayer.Domain.Projects;

namespace Inklayer.Tests.Domain;

public sealed class LivePageUrlTests
{
    [Theory]
    [InlineData("https://Example.com/pricing/?utm_source=x#faq", false, false, "https://example.com/pricing")]
    [InlineData("https://bücher.example/a", false, false, "https://xn--bcher-kva.example/a")]
    [InlineData("http://localhost:3000/x", false, false, "http://localhost:3000/x")]
    [InlineData("https://example.com/", false, false, "https://example.com/")]
    [InlineData("https://example.com", false, false, "https://example.com/")]
    [InlineData("https://example.com/Pricing", false, false, "https://example.com/Pricing")]
    [InlineData("https://example.com/search?b=2&a=1#top", true, false, "https://example.com/search?a=1&b=2")]
    [InlineData("https://example.com/app#/settings?x=1", false, true, "https://example.com/app#/settings?x=1")]
    [InlineData("https://example.com/app?", true, false, "https://example.com/app")]
    public void Keys_keep_the_query_and_hash_only_when_asked(string url, bool matchQuery, bool matchHash, string expected) =>
        Assert.Equal(expected, LivePageUrl.Normalize(url, matchQuery, matchHash));

    [Fact]
    public void A_page_has_a_key_with_and_without_its_query_and_hash()
    {
        Assert.Equal(
            ["https://www.youtube.com/watch", "https://www.youtube.com/watch?v=bm33vG-QHvE", "https://www.youtube.com/watch#t=30", "https://www.youtube.com/watch?v=bm33vG-QHvE#t=30"],
            LivePageUrl.Candidates("https://www.youtube.com/watch?v=bm33vG-QHvE#t=30"));
        Assert.Equal(["https://example.com/pricing"], LivePageUrl.Candidates("https://example.com/pricing/"));
        Assert.Empty(LivePageUrl.Candidates("chrome://settings"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("/relative")]
    [InlineData("chrome://settings")]
    [InlineData("file:///etc/passwd")]
    public void Non_web_urls_have_no_key(string? url) => Assert.Null(LivePageUrl.Normalize(url, matchQuery: true, matchHash: true));
}
