using System.Net;
using Inklayer.Domain.Network;

namespace Inklayer.Tests.Network;

public sealed class IpAllowListTests
{
    [Fact]
    public void Entries_are_addresses_or_ranges_in_canonical_form()
    {
        var list = IpAllowList.TryParse(["10.8.1.7/16", " 203.0.113.7 ", "2001:db8::/32", "::ffff:198.51.100.1", "", "10.8.0.0/16"], out var errors);

        Assert.Empty(errors);
        Assert.Equal(["10.8.0.0/16", "203.0.113.7/32", "2001:db8::/32", "198.51.100.1/32"], list!.Entries);
    }

    [Theory]
    [InlineData("10.8.0.0/33")]
    [InlineData("vpn.example.com")]
    [InlineData("10.8.0.0/x")]
    [InlineData("300.1.1.1")]
    public void Invalid_entries_are_reported(string entry)
    {
        Assert.Null(IpAllowList.TryParse(["10.0.0.0/8", entry], out var errors));
        Assert.Contains(entry, Assert.Single(errors), StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("10.8.200.3", true)]
    [InlineData("::ffff:10.8.0.1", true)]
    [InlineData("203.0.113.7", true)]
    [InlineData("203.0.113.8", false)]
    [InlineData("2001:db8:1::5", true)]
    [InlineData("2001:db9::5", false)]
    public void Addresses_are_allowed_only_inside_the_list(string address, bool allowed)
    {
        var list = IpAllowList.Parse("10.8.0.0/16, 203.0.113.7 2001:db8::/32");
        Assert.Equal(allowed, list.Allows(IPAddress.Parse(address)));
    }

    [Fact]
    public void An_empty_list_allows_everyone_and_a_list_refuses_unknown_addresses()
    {
        Assert.True(IpAllowList.Parse("").Allows(null));
        Assert.False(IpAllowList.Parse("10.0.0.0/8").Allows(null));
    }
}
