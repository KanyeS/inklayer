using System.Net;
using System.Net.Http.Json;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Api;

[Collection(ApiTestGroup.Name)]
public sealed class SystemEndpointTests(InklayerApiFactory factory)
{
    private readonly HttpClient _client = factory.CreateClient();

    [Theory]
    [InlineData("/health/live")]
    [InlineData("/health/ready")]
    public async Task Health_endpoints_report_healthy(string path)
    {
        var response = await _client.GetAsync(new Uri(path, UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("Healthy", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task Version_endpoint_returns_a_version()
    {
        var body = await _client.GetFromJsonAsync<VersionDto>("/api/system/version");

        Assert.False(string.IsNullOrWhiteSpace(body?.Version));
    }

    [Fact]
    public async Task OpenApi_document_is_served_and_lists_endpoints()
    {
        var json = await _client.GetStringAsync(new Uri("/openapi/v1.json", UriKind.Relative));

        Assert.Contains("/api/system/version", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Unknown_routes_return_404()
    {
        var response = await _client.GetAsync(new Uri("/does-not-exist", UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private sealed record VersionDto(string Version);
}
