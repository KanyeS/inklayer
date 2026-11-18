using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Api;

[Collection(ApiTestGroup.Name)]
public sealed class ViewerFallbackTests(InklayerApiFactory factory)
{
    [Theory]
    [InlineData("/api/does-not-exist")]
    [InlineData("/auth/nope")]
    [InlineData("/connect/nope")]
    public async Task Unknown_server_routes_are_404_never_the_spa(string path)
    {
        using var client = factory.CreateClient();

        using var response = await client.GetAsync(new Uri(path, UriKind.Relative));

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public void Viewer_policy_only_frames_the_snapshot_origin()
    {
        var policy = Inklayer.Api.Hosting.ViewerApp.ViewerPolicy(new Uri("https://snapshots.example.com"));

        Assert.Contains("frame-src https://snapshots.example.com;", policy, StringComparison.Ordinal);
        Assert.Contains("frame-ancestors 'none'", policy, StringComparison.Ordinal);
        Assert.DoesNotContain("unsafe-eval", policy, StringComparison.Ordinal);
    }
}
