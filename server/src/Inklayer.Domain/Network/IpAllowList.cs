using System.Net;
using System.Net.Sockets;

namespace Inklayer.Domain.Network;

/// <summary>
/// The networks Inklayer answers requests from, e.g. a company VPN's addresses. Entries are single addresses
/// (<c>203.0.113.7</c>, <c>2001:db8::1</c>) or CIDR ranges (<c>10.8.0.0/16</c>). An empty list allows every address.
/// </summary>
public sealed class IpAllowList
{
    public const int MaxEntries = 200;
    public const int MaxEntryLength = 64;

    public static readonly IpAllowList Empty = new([]);

    private IpAllowList(IReadOnlyList<IPNetwork> networks) => Networks = networks;

    public IReadOnlyList<IPNetwork> Networks { get; }

    public bool IsEmpty => Networks.Count == 0;

    /// <summary>The entries in canonical form (<c>10.8.0.0/16</c>, <c>203.0.113.7/32</c>), for storage and display.</summary>
    public IReadOnlyList<string> Entries => [.. Networks.Select(n => n.ToString())];

    /// <summary>Parses entries, ignoring blanks and duplicates. Returns null with the reasons if any entry is invalid.</summary>
    public static IpAllowList? TryParse(IEnumerable<string> entries, out List<string> errors)
    {
        errors = [];
        var networks = new List<IPNetwork>();
        foreach (var raw in entries)
        {
            var entry = raw.Trim();
            if (entry.Length == 0)
            {
                continue;
            }

            if (entry.Length > MaxEntryLength || !TryParseEntry(entry, out var network))
            {
                errors.Add($"\"{(entry.Length > MaxEntryLength ? entry[..MaxEntryLength] + "…" : entry)}\" isn't an IP address or a range like 10.8.0.0/16.");
            }
            else if (!networks.Contains(network))
            {
                networks.Add(network);
            }
        }

        if (networks.Count > MaxEntries)
        {
            errors.Add($"At most {MaxEntries} entries.");
        }

        return errors.Count == 0 ? new IpAllowList(networks) : null;
    }

    /// <summary>Parses entries separated by commas, semicolons, spaces or new lines. Throws if any is invalid.</summary>
    public static IpAllowList Parse(string? text)
    {
        var entries = (text ?? "").Split([',', ';', ' ', '\n', '\r', '\t'], StringSplitOptions.RemoveEmptyEntries);
        return TryParse(entries, out var errors) ?? throw new FormatException(string.Join(" ", errors));
    }

    /// <summary>Whether <paramref name="address"/> is in the list. An empty list allows everything; a missing address nothing.</summary>
    public bool Allows(IPAddress? address)
    {
        if (IsEmpty)
        {
            return true;
        }

        if (address is null)
        {
            return false;
        }

        address = Normalize(address);
        return Networks.Any(n => n.Contains(address));
    }

    /// <summary>IPv4 clients reached over a dual-stack socket arrive as <c>::ffff:1.2.3.4</c>; compare them as IPv4.</summary>
    public static IPAddress Normalize(IPAddress address) => address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address;

    private static bool TryParseEntry(string entry, out IPNetwork network)
    {
        if (entry.Contains('/', StringComparison.Ordinal))
        {
            // Accept "10.8.1.7/16" as the range it's in rather than refusing it.
            var slash = entry.IndexOf('/', StringComparison.Ordinal);
            if (IPAddress.TryParse(entry[..slash], out var baseAddress) && int.TryParse(entry[(slash + 1)..], out var prefix)
                && prefix >= 0 && prefix <= (baseAddress.AddressFamily == AddressFamily.InterNetwork ? 32 : 128))
            {
                baseAddress = Normalize(baseAddress);
                network = new IPNetwork(Mask(baseAddress, prefix), prefix);
                return true;
            }

            network = default;
            return false;
        }

        if (IPAddress.TryParse(entry, out var address))
        {
            address = Normalize(address);
            network = new IPNetwork(address, address.AddressFamily == AddressFamily.InterNetwork ? 32 : 128);
            return true;
        }

        network = default;
        return false;
    }

    private static IPAddress Mask(IPAddress address, int prefix)
    {
        var bytes = address.GetAddressBytes();
        for (var i = 0; i < bytes.Length; i++)
        {
            var bits = Math.Clamp(prefix - (i * 8), 0, 8);
            bytes[i] &= (byte)(0xFF << (8 - bits));
        }

        return new IPAddress(bytes);
    }
}
