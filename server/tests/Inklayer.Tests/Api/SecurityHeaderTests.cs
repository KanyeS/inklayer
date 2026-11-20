using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Api;

[Collection(ApiTestGroup.Name)]
public sealed class SecurityHeaderTests(InklayerApiFactory factory)
{
    private readonly HttpClient _client = factory.CreateClient();

    [Theory]
    [InlineData("/api/system/version")]
    [InlineData("/openapi/v1.json")]
    [InlineData("/api/system/does-not-exist")]
    public async Task Every_response_has_the_baseline_headers(string path)
    {
        using var response = await _client.GetAsync(new Uri(path, UriKind.Relative));

        Assert.Equal("nosniff", Header(response, "X-Content-Type-Options"));
        Assert.Equal("same-origin", Header(response, "Cross-Origin-Resource-Policy"));
        Assert.Equal("same-origin", Header(response, "Cross-Origin-Opener-Policy"));
        Assert.Equal("strict-origin-when-cross-origin", Header(response, "Referrer-Policy"));
        Assert.Contains("camera=()", Header(response, "Permissions-Policy"), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Api_responses_are_not_stored()
    {
        using var response = await _client.GetAsync(new Uri("/api/system/version", UriKind.Relative));

        Assert.True(response.Headers.CacheControl?.NoStore, "Expected Cache-Control: no-store");
    }

    [Fact]
    public async Task Share_links_keep_their_own_referrer_policy()
    {
        using var response = await _client.GetAsync(new Uri("/api/public/shares/not-a-token", UriKind.Relative));

        Assert.Equal("no-referrer", Header(response, "Referrer-Policy"));
    }

    private static string Header(HttpResponseMessage response, string name) =>
        string.Join(",", response.Headers.TryGetValues(name, out var values) ? values
            : response.Content.Headers.TryGetValues(name, out var content) ? content : []);
}
