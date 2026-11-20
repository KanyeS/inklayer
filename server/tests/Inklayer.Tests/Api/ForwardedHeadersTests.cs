using System.Net;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Inklayer.Tests.Api;

[Collection(ApiTestGroup.Name)]
public sealed class ForwardedHeadersTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task Known_networks_from_configuration_are_trusted()
    {
        // The setting is configured the way the Lightsail compose file sets it (ForwardedHeaders__KnownNetworks__0).
        await using var configured = factory.WithWebHostBuilder(b =>
            b.UseSetting("ForwardedHeaders:KnownNetworks:0", "172.16.0.0/12"));

        var options = configured.Services.GetRequiredService<IOptions<ForwardedHeadersOptions>>().Value;

        Assert.Contains(options.KnownIPNetworks, n => n.Contains(IPAddress.Parse("172.18.0.5")));
        using var client = configured.CreateClient();
        var response = await client.GetAsync(new Uri("/health/live", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task A_blank_known_network_is_ignored()
    {
        // The self-host compose file passes INKLAYER_TRUSTED_PROXY_NETWORK through, which is blank unless it's set.
        await using var configured = factory.WithWebHostBuilder(b =>
            b.UseSetting("ForwardedHeaders:KnownNetworks:0", ""));

        var options = configured.Services.GetRequiredService<IOptions<ForwardedHeadersOptions>>().Value;

        Assert.DoesNotContain(options.KnownIPNetworks, n => n.Contains(IPAddress.Parse("172.18.0.5")));
        using var client = configured.CreateClient();
        var response = await client.GetAsync(new Uri("/health/live", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
