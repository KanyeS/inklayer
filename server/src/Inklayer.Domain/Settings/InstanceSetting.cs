namespace Inklayer.Domain.Settings;

/// <summary>An instance-wide setting changed by instance administrators. A missing row means "use the server's configuration".</summary>
public sealed class InstanceSetting
{
    /// <summary>The networks Inklayer answers from, one entry per line (see <c>IpAllowList</c>). Empty: every network.</summary>
    public const string AllowedNetworks = "network.allowed";

    public required string Key { get; init; }

    public required string Value { get; set; }

    public DateTime UpdatedAt { get; set; }

    public Guid? UpdatedByUserId { get; set; }
}
