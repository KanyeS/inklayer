using System.Net;
using Inklayer.Api.Features.Annotations;
using Inklayer.Infrastructure;
using Microsoft.Extensions.Logging.Abstractions;

namespace Inklayer.Tests.Annotations;

/// <summary>Which network a comment came from: VPN and hosting providers recognised, private addresses ignored.</summary>
public sealed class NetworkLookupTests
{
    [Theory]
    [InlineData("NordVPN S.A.", "vpn")]
    [InlineData("31173 Services AB", "vpn")]
    [InlineData("Proton AG", "vpn")]
    [InlineData("DigitalOcean, LLC", "hosting")]
    [InlineData("Amazon.com, Inc.", "hosting")]
    [InlineData("M247 Europe SRL", "hosting")]
    [InlineData("Telstra Limited", "")]
    [InlineData("Telefonica Colombia", "")]
    [InlineData("Comcast Cable Communications, LLC", "")]
    public void Known_VPN_and_hosting_networks_are_recognised(string owner, string kind) => Assert.Equal(kind, DbIpNetworkLookup.KindOf(owner));

    [Theory]
    [InlineData("203.0.113.7", true)]
    [InlineData("1.1.1.1", true)]
    [InlineData("10.1.2.3", false)]
    [InlineData("172.20.0.1", false)]
    [InlineData("192.168.1.10", false)]
    [InlineData("100.70.1.1", false)]
    [InlineData("127.0.0.1", false)]
    [InlineData("::1", false)]
    [InlineData("fd00::1", false)]
    [InlineData("2001:4860:4860::8888", true)]
    public void Only_public_addresses_are_looked_up(string address, bool lookedUp) => Assert.Equal(lookedUp, DbIpNetworkLookup.IsPublic(IPAddress.Parse(address)));

    /// <summary>
    /// Against DB-IP's real files, when INKLAYER_IPDATA_DIR names a folder with asn.mmdb and country.mmdb (they're 9 MB each,
    /// so not in the repository).
    /// </summary>
    [Fact]
    public void Real_DB_IP_files_name_the_network_and_country()
    {
        if (Environment.GetEnvironmentVariable("INKLAYER_IPDATA_DIR") is not { Length: > 0 } folder)
        {
            return;
        }

        var root = Directory.CreateTempSubdirectory("inklayer-ipdata-").FullName;
        Directory.CreateSymbolicLink(Path.Combine(root, "ipdata"), folder);
        using var lookup = new DbIpNetworkLookup(new DataPaths(root), null!, TimeProvider.System, NullLogger<DbIpNetworkLookup>.Instance);
        lookup.Open();
        var google = lookup.Find(IPAddress.Parse("8.8.8.8"));
        Assert.NotNull(google);
        Assert.Contains("Google", google.Network, StringComparison.Ordinal);
        Assert.Equal("United States", google.Country);
        Assert.Equal("hosting", google.Kind);
        Assert.Null(lookup.Find(IPAddress.Parse("192.168.1.1")));
    }
}
