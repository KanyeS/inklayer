namespace Inklayer.Api.Auth;

public sealed class InklayerAuthOptions
{
    public const string SectionName = "Inklayer:Auth";

    public GoogleOptions Google { get; set; } = new();

    /// <summary>
    /// Emails that always become instance administrators when they sign in with Google. Use this for the first
    /// administrator and for recovery if every administrator is locked out. Comma-separated, or a list.
    /// </summary>
    public string BootstrapAdmins { get; set; } = "";

    /// <summary>Redirect URIs of the browser extension, e.g. <c>https://&lt;extension-id&gt;.chromiumapp.org/</c>. Comma-separated.</summary>
    public string ExtensionRedirectUris { get; set; } = "";

    /// <summary>Permit OAuth endpoints over plain HTTP. Only for local development; production must sit behind HTTPS.</summary>
    public bool AllowInsecureHttp { get; set; }

    public int InvitationLifetimeDays { get; set; } = 14;

    /// <summary>Requests per minute per client IP for /auth and /connect.</summary>
    public int AuthRequestsPerMinute { get; set; } = 30;

    public IReadOnlySet<string> BootstrapAdminEmails => Split(BootstrapAdmins);

    public IReadOnlyList<Uri> ExtensionRedirectUriList =>
        [.. Split(ExtensionRedirectUris).Select(u => new Uri(u, UriKind.Absolute))];

    private static HashSet<string> Split(string value) =>
        new(value.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(v => v.ToLowerInvariant()), StringComparer.Ordinal);

    public sealed class GoogleOptions
    {
        public string ClientId { get; set; } = "";

        public string ClientSecret { get; set; } = "";

        public bool IsConfigured => ClientId.Length > 0 && ClientSecret.Length > 0;
    }
}
