using System.Text.RegularExpressions;

namespace Inklayer.Api.Auth;

public sealed partial class InklayerAuthOptions
{
    public const string SectionName = "Inklayer:Auth";

    public GoogleOptions Google { get; set; } = new();

    /// <summary>
    /// Other OpenID Connect providers, such as JumpCloud, Okta, Microsoft Entra ID, Authentik or Keycloak. Configure them as
    /// <c>Inklayer:Auth:Oidc:0:Id</c>, <c>Inklayer:Auth:Oidc:0:Authority</c> and so on.
    /// </summary>
    public List<OidcProviderOptions> Oidc { get; set; } = [];

    /// <summary>
    /// Emails that always become instance administrators when they sign in. Use this for the first administrator and for
    /// recovery if every administrator is locked out. Comma-separated, or a list.
    /// </summary>
    public string BootstrapAdmins { get; set; } = "";

    /// <summary>
    /// Sign-in addresses of the official extension, always allowed. They are fixed: Chrome's comes from the Web Store
    /// public key in the manifest (<c>key</c>), Firefox's from the add-on ID <c>inklayer-extension@inklayer</c>. Only the
    /// browser's identity API for that extension can receive a redirect to them, so allowing them needs no setup.
    /// </summary>
    public static readonly IReadOnlyList<Uri> OfficialExtensionRedirectUris =
    [
        new("https://cihhaaceflhcncmeoiembekghkhbgfio.chromiumapp.org/"),
        new("https://01fc551d14085f05b25b6448f79709265f7c52ab.extensions.allizom.org/"),
    ];

    /// <summary>
    /// Extra redirect URIs for builds of the extension with a different ID (forks), comma-separated:
    /// <c>https://&lt;extension-id&gt;.chromiumapp.org/</c> for Chrome, <c>https://&lt;hash&gt;.extensions.allizom.org/</c>
    /// for Firefox. The official extension's addresses are always allowed, so most servers leave this empty.
    /// </summary>
    public string ExtensionRedirectUris { get; set; } = "";

    /// <summary>Permit OAuth endpoints over plain HTTP. Only for local development; production must sit behind HTTPS.</summary>
    public bool AllowInsecureHttp { get; set; }

    public int InvitationLifetimeDays { get; set; } = 14;

    /// <summary>Requests per minute per client IP for /auth and /connect.</summary>
    public int AuthRequestsPerMinute { get; set; } = 30;

    public IReadOnlySet<string> BootstrapAdminEmails => Split(BootstrapAdmins);

    /// <summary>The official extension's addresses, then any extra ones from <see cref="ExtensionRedirectUris"/>.</summary>
    public IReadOnlyList<Uri> ExtensionRedirectUriList =>
        [.. OfficialExtensionRedirectUris.Concat(Split(ExtensionRedirectUris).Select(u => new Uri(u, UriKind.Absolute))).Distinct()];

    /// <summary>Every sign-in provider that is fully configured, Google first.</summary>
    public IReadOnlyList<SignInProvider> Providers =>
        [
            .. Google.IsConfigured ? [new SignInProvider(AuthSchemes.Google, "Google")] : Array.Empty<SignInProvider>(),
            .. Oidc.Where(o => o.IsConfigured).Select(o => new SignInProvider(o.Id, o.DisplayNameOrId)),
        ];

    public OidcProviderOptions? FindOidc(string id) => Oidc.Find(o => o.IsConfigured && o.Id == id);

    /// <summary>Throws if the provider configuration is unusable, so a misconfigured server fails at startup instead of at sign-in.</summary>
    public void Validate(bool allowInsecureHttp)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        if (Google.IsConfigured)
        {
            ids.Add(AuthSchemes.Google);
        }

        foreach (var partial in Oidc.Where(o => !o.IsConfigured && o.IsPartlyConfigured))
        {
            throw new InvalidOperationException(
                $"OIDC provider '{partial.Id}' is only partly configured. Set Id, Authority and ClientId (and ClientSecret unless it is a public client), or none of them.");
        }

        foreach (var provider in Oidc.Where(o => o.IsConfigured))
        {
            if (!IsValidProviderId(provider.Id))
            {
                throw new InvalidOperationException(
                    $"OIDC provider id '{provider.Id}' is invalid. Use 1-32 lower-case letters, digits or dashes, e.g. 'jumpcloud'.");
            }

            if (!ids.Add(provider.Id))
            {
                throw new InvalidOperationException($"OIDC provider id '{provider.Id}' is used more than once (the id 'google' is reserved for Inklayer:Auth:Google).");
            }

            if (!IsValidAuthority(provider.Authority, allowInsecureHttp))
            {
                throw new InvalidOperationException($"OIDC provider '{provider.Id}' needs an https Authority (the issuer URL), got '{provider.Authority}'.");
            }
        }
    }

    /// <summary>1-32 lower-case letters, digits or dashes: the id is part of the callback URL.</summary>
    public static bool IsValidProviderId(string id) => ProviderIdPattern().IsMatch(id);

    /// <summary>An absolute https address (or http, for a plain-HTTP trial).</summary>
    public static bool IsValidAuthority(string authority, bool allowInsecureHttp) =>
        Uri.TryCreate(authority, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttps || (allowInsecureHttp && uri.Scheme == Uri.UriSchemeHttp));

    internal static HashSet<string> Split(string value) =>
        new(value.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(v => v.ToLowerInvariant()), StringComparer.Ordinal);

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{0,31}$")]
    private static partial Regex ProviderIdPattern();

    public sealed class GoogleOptions
    {
        public string ClientId { get; set; } = "";

        public string ClientSecret { get; set; } = "";

        public bool IsConfigured => ClientId.Length > 0 && ClientSecret.Length > 0;
    }

    public sealed class OidcProviderOptions
    {
        /// <summary>
        /// Short, stable id such as <c>jumpcloud</c>. It is part of the callback URL (<c>/auth/callback/&lt;id&gt;</c>) and
        /// links users to their provider accounts, so don't change it once people have signed in.
        /// </summary>
        public string Id { get; set; } = "";

        /// <summary>Shown on the sign-in button: "Sign in with &lt;DisplayName&gt;".</summary>
        public string DisplayName { get; set; } = "";

        /// <summary>The provider's issuer URL. Its <c>/.well-known/openid-configuration</c> must be reachable from the server.</summary>
        public string Authority { get; set; } = "";

        public string ClientId { get; set; } = "";

        public string ClientSecret { get; set; } = "";

        /// <summary>Space-separated scopes. <c>openid</c> is always requested.</summary>
        public string Scopes { get; set; } = "openid email profile";

        /// <summary>
        /// Email domains this provider is the authority for, comma-separated (e.g. <c>acme.com</c>). For people from these
        /// domains the provider's email is trusted even without an <c>email_verified</c> claim, they join an organisation
        /// that allows the domain, and an existing Inklayer account with the same email (say, from Google) is linked to
        /// this provider. Only list domains whose accounts this provider really controls.
        /// </summary>
        public string VerifiedDomains { get; set; } = "";

        public string DisplayNameOrId => DisplayName.Length > 0 ? DisplayName : Id;

        public IReadOnlySet<string> VerifiedDomainSet => Split(VerifiedDomains);

        public bool IsConfigured => Id.Length > 0 && Authority.Length > 0 && ClientId.Length > 0;

        internal bool IsPartlyConfigured => Id.Length > 0 || Authority.Length > 0 || ClientId.Length > 0 || ClientSecret.Length > 0;
    }
}

public sealed record SignInProvider(string Id, string DisplayName);
