namespace Inklayer.Domain.Settings;

/// <summary>An instance-wide setting changed by instance administrators. A missing row means "use the server's configuration".</summary>
public sealed class InstanceSetting
{
    /// <summary>The networks Inklayer answers from, one entry per line (see <c>IpAllowList</c>). Empty: every network.</summary>
    public const string AllowedNetworks = "network.allowed";

    /// <summary>Features an administrator turned on or off, as JSON (<c>{"docs":false}</c>). Features not listed follow the server's configuration.</summary>
    public const string Features = "features";

    /// <summary>OpenID Connect sign-in providers administrators added, as JSON. Client secrets are encrypted. Configured providers aren't in it.</summary>
    public const string SignInProviders = "auth.providers";

    public required string Key { get; init; }

    public required string Value { get; set; }

    public DateTime UpdatedAt { get; set; }

    public Guid? UpdatedByUserId { get; set; }
}
