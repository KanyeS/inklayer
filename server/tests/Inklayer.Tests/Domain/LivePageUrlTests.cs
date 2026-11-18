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
    public void Pages_are_keyed_by_the_project_rules(string url, bool matchQuery, bool matchHash, string expected) =>
        Assert.Equal(expected, LivePageUrl.Normalize(url, matchQuery, matchHash));

    [Fact]
    public void Loosening_the_rules_merges_existing_keys()
    {
        var withQuery = LivePageUrl.Normalize("https://example.com/search?q=shoes", matchQuery: true, matchHash: false);
        Assert.Equal("https://example.com/search", LivePageUrl.Normalize(withQuery, matchQuery: false, matchHash: false));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("/relative")]
    [InlineData("chrome://settings")]
    [InlineData("file:///etc/passwd")]
    public void Non_web_urls_have_no_key(string? url) => Assert.Null(LivePageUrl.Normalize(url, matchQuery: true, matchHash: true));
}
