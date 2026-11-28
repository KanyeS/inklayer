using System.Globalization;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using Inklayer.Domain.Issues;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Issues;

/// <summary>
/// The OAuth apps people connect their own tracker accounts through, under <c>Inklayer:Trackers</c>
/// (<c>Inklayer:Trackers:GitHub:ClientId</c> and so on). A tracker without one uses connections' shared tokens only.
/// Each app's callback URL is <c>https://&lt;server&gt;/api/me/tracker-accounts/&lt;kind&gt;/callback</c>.
/// </summary>
public sealed class TrackerOAuthOptions
{
    public const string SectionName = "Inklayer:Trackers";

    public GitHubOAuthOptions GitHub { get; set; } = new();

    /// <summary>gitlab.com, or one self-managed GitLab (<see cref="InstanceOAuthOptions.Url"/>).</summary>
    public InstanceOAuthOptions GitLab { get; set; } = new() { Url = "https://gitlab.com" };

    /// <summary>Codeberg, or one self-hosted Forgejo or Gitea (<see cref="InstanceOAuthOptions.Url"/>).</summary>
    public InstanceOAuthOptions Forgejo { get; set; } = new() { Url = "https://codeberg.org" };

    public OAuthClientOptions Linear { get; set; } = new();

    /// <summary>An Atlassian OAuth 2.0 (3LO) app, for Jira Cloud.</summary>
    public OAuthClientOptions Jira { get; set; } = new();

    public AzureDevOpsOAuthOptions AzureDevOps { get; set; } = new();

    public class OAuthClientOptions
    {
        public string ClientId { get; set; } = "";

        public string ClientSecret { get; set; } = "";

        public virtual bool IsConfigured => ClientId.Length > 0 && ClientSecret.Length > 0;
    }

    public sealed class GitHubOAuthOptions : OAuthClientOptions
    {
        /// <summary>Where people sign in: github.com, or a GitHub Enterprise Server.</summary>
        public string WebUrl { get; set; } = "https://github.com";

        /// <summary>The API of the same GitHub. Connections to repositories there use people's own accounts.</summary>
        public string ApiUrl { get; set; } = "https://api.github.com";
    }

    public sealed class InstanceOAuthOptions : OAuthClientOptions
    {
        /// <summary>The instance's address. Connections to projects there use people's own accounts.</summary>
        public string Url { get; set; } = "";
    }

    /// <summary>A Microsoft Entra ID app registration with the Azure DevOps permission (user_impersonation).</summary>
    public sealed class AzureDevOpsOAuthOptions : OAuthClientOptions
    {
        /// <summary>The Entra tenant (directory) id, or <c>organizations</c> for any work or school account.</summary>
        public string TenantId { get; set; } = "organizations";

        /// <summary>
        /// A certificate to sign in to Entra with instead of <see cref="OAuthClientOptions.ClientSecret"/>: a PEM file with the
        /// certificate and its RSA private key, or a <c>.pfx</c>. Used when set, even if there's a secret too.
        /// </summary>
        public string CertificatePath { get; set; } = "";

        /// <summary>The password of a <c>.pfx</c>, or of an encrypted PEM private key.</summary>
        public string CertificatePassword { get; set; } = "";

        public override bool IsConfigured => ClientId.Length > 0 && (ClientSecret.Length > 0 || CertificatePath.Length > 0);
    }
}

/// <summary>What a tracker's token endpoint gave back.</summary>
internal sealed record OAuthTokens(string AccessToken, string? RefreshToken, DateTime? ExpiresAt);

/// <summary>Who the account is. <see cref="Sites"/>: the Jira sites (cloud id and address) it was allowed on.</summary>
internal sealed record OAuthIdentity(string Id, string Login, string? ProfileUrl, List<JiraSite>? Sites = null);

internal sealed record JiraSite(string Id, string Url);

/// <summary>
/// The server's OAuth app is set up wrong (a certificate it can't read, say). Not the account's fault, so accounts aren't
/// forgotten over it.
/// </summary>
internal sealed class TrackerOAuthSetupException(string message, Exception? inner = null) : Exception(message, inner);

/// <summary>
/// The OAuth details of each tracker: where people allow Inklayer, how codes and refresh tokens become access tokens,
/// who the account is, and how to give access back.
/// </summary>
internal sealed class TrackerOAuth(IOptions<TrackerOAuthOptions> options, TrackerOAuthApps apps, IHttpClientFactory http, TimeProvider clock)
{
    private readonly Lazy<X509Certificate2> certificate = new(
        () => LoadCertificate(options.Value.AzureDevOps.CertificatePath, options.Value.AzureDevOps.CertificatePassword), LazyThreadSafetyMode.PublicationOnly);

    /// <summary>The Azure DevOps resource, in Microsoft Entra.</summary>
    private const string AzureDevOpsScope = "499b84ac-1321-427f-aa17-267ca6975798/user_impersonation offline_access";

    private const string AtlassianApi = "https://api.atlassian.com";

    /// <summary>The configuration's apps, with those administrators added for the trackers it leaves out.</summary>
    private TrackerOAuthOptions O => apps.Current;

    private TrackerOAuthOptions.OAuthClientOptions? Client(string kind) => TrackerOAuthApps.Client(O, kind);

    public bool Available(string kind) => Client(kind) is { IsConfigured: true };

    /// <summary>The instance people's accounts are on, for GitHub, GitLab and Forgejo; null for the others.</summary>
    public string? Instance(string kind) => kind switch
    {
        TrackerKinds.GitHub => Trim(O.GitHub.WebUrl),
        TrackerKinds.GitLab => Trim(O.GitLab.Url),
        TrackerKinds.Forgejo => Trim(O.Forgejo.Url),
        _ => null,
    };

    /// <summary>Whether people's own accounts work for a connection with these settings: the right instance, and the app is set up.</summary>
    public bool PersonalFor(string kind, TrackerSettings s) => Available(kind) && kind switch
    {
        TrackerKinds.GitHub => Same(s.ApiUrl is { Length: > 0 } api ? api : "https://api.github.com", O.GitHub.ApiUrl),
        TrackerKinds.GitLab => Same(s.Site is { Length: > 0 } site ? site : "https://gitlab.com", O.GitLab.Url),
        TrackerKinds.Forgejo => Same(s.Site is { Length: > 0 } site ? site : "https://codeberg.org", O.Forgejo.Url),
        // Entra sign-in is for Azure DevOps Services, not Server.
        TrackerKinds.AzureDevOps => Uri.TryCreate(s.Site, UriKind.Absolute, out var u)
            && (u.Host.Equals("dev.azure.com", StringComparison.OrdinalIgnoreCase) || u.Host.EndsWith(".visualstudio.com", StringComparison.OrdinalIgnoreCase)),
        _ => true,
    };

    private static bool Pkce(string kind) => kind != TrackerKinds.Jira;

    public string AuthorizeUrl(string kind, string redirectUri, string state, string challenge)
    {
        var client = Client(kind)!;
        var (url, extra) = kind switch
        {
            TrackerKinds.GitHub => ($"{Trim(O.GitHub.WebUrl)}/login/oauth/authorize", "&scope=repo&allow_signup=false"),
            TrackerKinds.GitLab => ($"{Trim(O.GitLab.Url)}/oauth/authorize", "&scope=api"),
            TrackerKinds.Forgejo => ($"{Trim(O.Forgejo.Url)}/login/oauth/authorize", ""),
            TrackerKinds.Linear => ("https://linear.app/oauth/authorize", $"&scope={E("read,write")}&prompt=consent"),
            TrackerKinds.Jira => ("https://auth.atlassian.com/authorize",
                $"&audience=api.atlassian.com&prompt=consent&scope={E("read:jira-work write:jira-work read:jira-user read:me offline_access")}"),
            TrackerKinds.AzureDevOps => ($"https://login.microsoftonline.com/{E(O.AzureDevOps.TenantId)}/oauth2/v2.0/authorize",
                $"&scope={E(AzureDevOpsScope)}&response_mode=query"),
            _ => throw new InvalidOperationException($"Unknown tracker {kind}."),
        };
        var pkce = Pkce(kind) ? $"&code_challenge={challenge}&code_challenge_method=S256" : "";
        return $"{url}?client_id={E(client.ClientId)}&redirect_uri={E(redirectUri)}&response_type=code&state={E(state)}{pkce}{extra}";
    }

    public Task<OAuthTokens> ExchangeAsync(string kind, string code, string verifier, string redirectUri, CancellationToken ct) =>
        TokenAsync(kind, new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code", ["code"] = code, ["redirect_uri"] = redirectUri,
            [Pkce(kind) ? "code_verifier" : ""] = verifier,
        }, ct);

    /// <param name="redirectUri">The address the account was connected with; GitLab wants it again.</param>
    public Task<OAuthTokens> RefreshAsync(string kind, string refreshToken, string? redirectUri, CancellationToken ct)
    {
        var fields = new Dictionary<string, string> { ["grant_type"] = "refresh_token", ["refresh_token"] = refreshToken };
        if (kind == TrackerKinds.GitLab && redirectUri is not null)
        {
            fields["redirect_uri"] = redirectUri;
        }

        return TokenAsync(kind, fields, ct);
    }

    private async Task<OAuthTokens> TokenAsync(string kind, Dictionary<string, string> fields, CancellationToken ct)
    {
        var client = Client(kind)!;
        var url = kind switch
        {
            TrackerKinds.GitHub => $"{Trim(O.GitHub.WebUrl)}/login/oauth/access_token",
            TrackerKinds.GitLab => $"{Trim(O.GitLab.Url)}/oauth/token",
            TrackerKinds.Forgejo => $"{Trim(O.Forgejo.Url)}/login/oauth/access_token",
            TrackerKinds.Linear => "https://api.linear.app/oauth/token",
            TrackerKinds.Jira => "https://auth.atlassian.com/oauth/token",
            TrackerKinds.AzureDevOps => $"https://login.microsoftonline.com/{E(O.AzureDevOps.TenantId)}/oauth2/v2.0/token",
            _ => throw new InvalidOperationException($"Unknown tracker {kind}."),
        };
        fields.Remove("");
        fields["client_id"] = client.ClientId;
        if (kind == TrackerKinds.AzureDevOps && O.AzureDevOps.CertificatePath.Length > 0)
        {
            fields["client_assertion_type"] = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
            fields["client_assertion"] = ClientAssertion(client.ClientId, url);
        }
        else
        {
            fields["client_secret"] = client.ClientSecret;
        }

        if (kind == TrackerKinds.AzureDevOps)
        {
            fields["scope"] = AzureDevOpsScope;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, url)
        {
            // Atlassian takes JSON; the rest take a form.
            Content = kind == TrackerKinds.Jira ? Trackers.Json(fields) : new FormUrlEncodedContent(fields),
        };
        request.Headers.Accept.ParseAdd("application/json");
        var answer = await Trackers.SendAsync(http, request, ct);
        if (answer?["access_token"]?.GetValue<string>() is not { Length: > 0 } token)
        {
            throw new InvalidOperationException(answer?["error_description"]?.GetValue<string>() ?? answer?["error"]?.GetValue<string>() ?? "No token came back.");
        }

        var expiresIn = answer["expires_in"] is JsonValue v && (v.TryGetValue<long>(out var n) || long.TryParse(v.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out n))
            ? n
            : (long?)null;
        return new OAuthTokens(token, answer["refresh_token"]?.GetValue<string>(), expiresIn is { } s ? clock.GetUtcNow().UtcDateTime.AddSeconds(s) : null);
    }

    public async Task<OAuthIdentity> IdentifyAsync(string kind, string accessToken, CancellationToken ct)
    {
        switch (kind)
        {
            case TrackerKinds.GitHub:
            {
                var user = await GetAsync($"{Trim(O.GitHub.ApiUrl)}/user", accessToken, ct);
                var login = user?["login"]?.GetValue<string>() ?? throw new InvalidOperationException("GitHub didn't say who the account is.");
                return new OAuthIdentity(Trackers.Id(user["id"]), login, user["html_url"]?.GetValue<string>() ?? $"{Trim(O.GitHub.WebUrl)}/{login}");
            }

            case TrackerKinds.GitLab:
            {
                var user = await GetAsync($"{Trim(O.GitLab.Url)}/api/v4/user", accessToken, ct);
                var login = user?["username"]?.GetValue<string>() ?? throw new InvalidOperationException("GitLab didn't say who the account is.");
                return new OAuthIdentity(Trackers.Id(user["id"]), login, user["web_url"]?.GetValue<string>());
            }

            case TrackerKinds.Forgejo:
            {
                var user = await GetAsync($"{Trim(O.Forgejo.Url)}/api/v1/user", accessToken, ct);
                var login = user?["login"]?.GetValue<string>() ?? throw new InvalidOperationException("Forgejo didn't say who the account is.");
                return new OAuthIdentity(Trackers.Id(user["id"]), login, $"{Trim(O.Forgejo.Url)}/{Uri.EscapeDataString(login)}");
            }

            case TrackerKinds.Linear:
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.linear.app/graphql")
                {
                    Content = Trackers.Json(new { query = "{ viewer { id name displayName url } }" }),
                };
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                var viewer = (await Trackers.SendAsync(http, request, ct))?["data"]?["viewer"] ?? throw new InvalidOperationException("Linear didn't say who the account is.");
                return new OAuthIdentity(Trackers.Id(viewer["id"]), viewer["displayName"]?.GetValue<string>() ?? viewer["name"]?.GetValue<string>() ?? "Linear",
                    viewer["url"]?.GetValue<string>());
            }

            case TrackerKinds.Jira:
            {
                var me = await GetAsync($"{AtlassianApi}/me", accessToken, ct);
                var id = me?["account_id"]?.GetValue<string>() ?? throw new InvalidOperationException("Atlassian didn't say who the account is.");
                var name = me["name"]?.GetValue<string>() ?? me["nickname"]?.GetValue<string>() ?? me["email"]?.GetValue<string>() ?? "Atlassian";
                return new OAuthIdentity(id, name, null, await JiraSitesAsync(accessToken, ct));
            }

            case TrackerKinds.AzureDevOps:
            {
                // Who signed in, from Entra's own token. Azure DevOps' profile service has no profile for some Entra identities
                // (VSS011031), so it's only asked when the token can't be read.
                if (EntraIdentity(accessToken) is { } identity)
                {
                    return identity;
                }

                var me = await GetAsync("https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1", accessToken, ct);
                var id = me?["id"]?.GetValue<string>() ?? throw new InvalidOperationException("Azure DevOps didn't say who the account is.");
                return new OAuthIdentity(id, me["emailAddress"]?.GetValue<string>() ?? me["displayName"]?.GetValue<string>() ?? "Azure DevOps", null);
            }

            default:
                throw new InvalidOperationException($"Unknown tracker {kind}.");
        }
    }

    /// <summary>The Jira sites the account allowed Inklayer on, with their cloud ids.</summary>
    public async Task<List<JiraSite>> JiraSitesAsync(string accessToken, CancellationToken ct)
    {
        var resources = (await GetAsync($"{AtlassianApi}/oauth/token/accessible-resources", accessToken, ct))?.AsArray() ?? [];
        return [.. resources.Where(r => r?["id"] is not null && r["url"] is not null).Select(r => new JiraSite(r!["id"]!.GetValue<string>(), r["url"]!.GetValue<string>()))];
    }

    /// <summary>The API address for a Jira site, through Atlassian's gateway; null if the account wasn't allowed on it.</summary>
    public static string? JiraApi(IEnumerable<JiraSite> sites, string site) =>
        sites.FirstOrDefault(s => Same(s.Url, site)) is { } found ? $"{AtlassianApi}/ex/jira/{Uri.EscapeDataString(found.Id)}" : null;

    /// <summary>Gives the access back, where the tracker lets apps do that. Best effort.</summary>
    public async Task RevokeAsync(string kind, string accessToken, CancellationToken ct)
    {
        HttpRequestMessage? request = kind switch
        {
            TrackerKinds.GitHub => new HttpRequestMessage(HttpMethod.Delete, $"{Trim(O.GitHub.ApiUrl)}/applications/{E(O.GitHub.ClientId)}/grant")
            {
                Content = Trackers.Json(new { access_token = accessToken }),
            },
            TrackerKinds.GitLab => new HttpRequestMessage(HttpMethod.Post, $"{Trim(O.GitLab.Url)}/oauth/revoke")
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["token"] = accessToken, ["client_id"] = O.GitLab.ClientId, ["client_secret"] = O.GitLab.ClientSecret,
                }),
            },
            TrackerKinds.Linear => new HttpRequestMessage(HttpMethod.Post, "https://api.linear.app/oauth/revoke"),
            _ => null,
        };
        if (request is null)
        {
            return;
        }

        using (request)
        {
            request.Headers.Authorization = kind == TrackerKinds.GitHub
                ? new AuthenticationHeaderValue("Basic", Convert.ToBase64String(Encoding.UTF8.GetBytes($"{O.GitHub.ClientId}:{O.GitHub.ClientSecret}")))
                : new AuthenticationHeaderValue("Bearer", accessToken);
            request.Headers.Accept.ParseAdd("application/json");
            request.Headers.UserAgent.ParseAdd("Inklayer");
            try
            {
                await Trackers.SendAsync(http, request, ct);
            }
            catch (HttpRequestException)
            {
            }
        }
    }

    private async Task<JsonNode?> GetAsync(string url, string accessToken, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Headers.Accept.ParseAdd("application/json");
        request.Headers.UserAgent.ParseAdd("Inklayer");
        return await Trackers.SendAsync(http, request, ct);
    }

    /// <summary>
    /// Proof that the server holds the certificate's private key, in place of a client secret: a short-lived JWT for the
    /// token endpoint, signed with the key (PS256) and naming the certificate by its SHA-256 thumbprint.
    /// </summary>
    private string ClientAssertion(string clientId, string audience)
    {
        var cert = certificate.Value;
        var now = clock.GetUtcNow().ToUnixTimeSeconds();
        var header = new JsonObject { ["alg"] = "PS256", ["typ"] = "JWT", ["x5t#S256"] = Base64Url(cert.GetCertHash(HashAlgorithmName.SHA256)) };
        var claims = new JsonObject
        {
            ["aud"] = audience, ["iss"] = clientId, ["sub"] = clientId, ["jti"] = Guid.NewGuid().ToString(), ["nbf"] = now, ["iat"] = now, ["exp"] = now + 300,
        };
        var signed = $"{Base64Url(Encoding.UTF8.GetBytes(header.ToJsonString()))}.{Base64Url(Encoding.UTF8.GetBytes(claims.ToJsonString()))}";
        using var key = cert.GetRSAPrivateKey()!;
        return $"{signed}.{Base64Url(key.SignData(Encoding.ASCII.GetBytes(signed), HashAlgorithmName.SHA256, RSASignaturePadding.Pss))}";
    }

    private static X509Certificate2 LoadCertificate(string path, string password)
    {
        X509Certificate2 cert;
        try
        {
            cert = path.EndsWith(".pfx", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".p12", StringComparison.OrdinalIgnoreCase)
                ? X509CertificateLoader.LoadPkcs12FromFile(path, password.Length > 0 ? password : null)
                : password.Length > 0 ? X509Certificate2.CreateFromEncryptedPemFile(path, password) : X509Certificate2.CreateFromPemFile(path);
        }
        catch (Exception ex) when (ex is CryptographicException or IOException or UnauthorizedAccessException or ArgumentException)
        {
            throw new TrackerOAuthSetupException($"The server couldn't read its Azure DevOps certificate ({path}): {ex.Message}", ex);
        }

        using var key = cert.GetRSAPrivateKey();
        if (key is null)
        {
            cert.Dispose();
            throw new TrackerOAuthSetupException($"The Azure DevOps certificate ({path}) needs its RSA private key in the same file.");
        }

        return cert;
    }

    /// <summary>
    /// The person in an Entra access token: its object id, and their sign-in name or email. The token came straight from
    /// Entra's token endpoint over HTTPS, so its claims are read without checking the signature (Azure DevOps checks that).
    /// </summary>
    internal static OAuthIdentity? EntraIdentity(string accessToken)
    {
        var parts = accessToken.Split('.');
        if (parts.Length != 3)
        {
            return null;
        }

        JsonNode? claims;
        try
        {
            var b64 = parts[1].Replace('-', '+').Replace('_', '/');
            claims = JsonNode.Parse(Convert.FromBase64String(b64.PadRight(b64.Length + ((4 - (b64.Length % 4)) % 4), '=')));
        }
        catch (Exception ex) when (ex is FormatException or System.Text.Json.JsonException)
        {
            return null;
        }

        string? Claim(string name) => claims?[name] is JsonValue v && v.TryGetValue<string>(out var s) && s.Length > 0 ? s : null;
        if (Claim("oid") is not { } oid)
        {
            return null;
        }

        // Personal Microsoft accounts in a directory sign in as "live.com#name@example.com".
        var login = Claim("upn") ?? Claim("email") ?? Claim("unique_name") ?? Claim("preferred_username") ?? Claim("name") ?? "Azure DevOps";
        var hash = login.LastIndexOf('#');
        return new OAuthIdentity(oid, hash >= 0 && hash < login.Length - 1 ? login[(hash + 1)..] : login, null);
    }

    private static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static string Trim(string url) => url.TrimEnd('/');

    internal static bool Same(string a, string b) => string.Equals(a.TrimEnd('/'), b.TrimEnd('/'), StringComparison.OrdinalIgnoreCase);

    private static string E(string value) => Uri.EscapeDataString(value);
}
