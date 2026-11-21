using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Web;
using Inklayer.Api.Features.Issues;
using Inklayer.Domain.Issues;
using Inklayer.Tests.Infrastructure;
using Microsoft.Extensions.Options;

namespace Inklayer.Tests.Features;

/// <summary>Signing in to Microsoft Entra with a certificate instead of a client secret, for people's own Azure DevOps accounts.</summary>
public sealed class AzureDevOpsCertificateTests : IDisposable
{
    private const string TokenUrl = "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token";
    private readonly string directory = Directory.CreateTempSubdirectory("inklayer-cert-").FullName;
    private readonly FakeOutboundHandler outbound = new();

    public void Dispose()
    {
        outbound.Dispose();
        Directory.Delete(directory, recursive: true);
    }

    private sealed class Factory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private TrackerOAuth OAuth(string certificatePath, string password = "", string secret = "") => new(
        Options.Create(new TrackerOAuthOptions
        {
            AzureDevOps = new() { ClientId = "az-client", ClientSecret = secret, TenantId = "tenant-1", CertificatePath = certificatePath, CertificatePassword = password },
        }),
        new Factory(outbound), TimeProvider.System);

    private void AnswerTokens() => outbound.Responders[TokenUrl] = (_, _) => new HttpResponseMessage(HttpStatusCode.OK)
    {
        Content = new StringContent("""{"access_token":"at-1","refresh_token":"rt-1","expires_in":3600}""", Encoding.UTF8, "application/json"),
    };

    private static X509Certificate2 NewCertificate(RSA key) =>
        new CertificateRequest("CN=Inklayer", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1).CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));

    private static byte[] FromBase64Url(string value)
    {
        var s = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + ((4 - (s.Length % 4)) % 4), '='));
    }

    [Fact]
    public async Task Tokens_are_asked_for_with_a_signed_assertion_instead_of_the_secret()
    {
        using var key = RSA.Create(2048);
        using var cert = NewCertificate(key);
        var path = Path.Combine(directory, "azuredevops.pem");
        await File.WriteAllTextAsync(path, cert.ExportCertificatePem() + "\n" + key.ExportPkcs8PrivateKeyPem());
        AnswerTokens();

        // A secret is set too, but the certificate wins.
        var oauth = OAuth(path, secret: "az-secret");
        Assert.True(oauth.Available(TrackerKinds.AzureDevOps));
        var tokens = await oauth.ExchangeAsync(TrackerKinds.AzureDevOps, "the-code", "verifier", "https://inklayer.test/callback", default);
        Assert.Equal("at-1", tokens.AccessToken);
        await oauth.RefreshAsync(TrackerKinds.AzureDevOps, "rt-1", null, default);

        foreach (var (_, body) in outbound.To(TokenUrl))
        {
            var form = HttpUtility.ParseQueryString(body);
            Assert.Null(form["client_secret"]);
            Assert.Equal("urn:ietf:params:oauth:client-assertion-type:jwt-bearer", form["client_assertion_type"]);

            // A JWT signed with the certificate's key (PS256), naming it by its SHA-256 thumbprint, for this token endpoint.
            var parts = form["client_assertion"]!.Split('.');
            Assert.Equal(3, parts.Length);
            using var header = JsonDocument.Parse(FromBase64Url(parts[0]));
            Assert.Equal("PS256", header.RootElement.GetProperty("alg").GetString());
            Assert.Equal(cert.GetCertHash(HashAlgorithmName.SHA256), FromBase64Url(header.RootElement.GetProperty("x5t#S256").GetString()!));
            using var claims = JsonDocument.Parse(FromBase64Url(parts[1]));
            Assert.Equal(TokenUrl, claims.RootElement.GetProperty("aud").GetString());
            Assert.Equal("az-client", claims.RootElement.GetProperty("iss").GetString());
            Assert.Equal("az-client", claims.RootElement.GetProperty("sub").GetString());
            var exp = DateTimeOffset.FromUnixTimeSeconds(claims.RootElement.GetProperty("exp").GetInt64());
            Assert.InRange(exp, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow.AddMinutes(10));
            using var publicKey = cert.GetRSAPublicKey()!;
            Assert.True(publicKey.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), FromBase64Url(parts[2]), HashAlgorithmName.SHA256, RSASignaturePadding.Pss));
        }

        Assert.Equal(2, outbound.To(TokenUrl).Count());
    }

    [Fact]
    public async Task A_password_protected_pfx_works_too()
    {
        using var key = RSA.Create(2048);
        using var cert = NewCertificate(key);
        var path = Path.Combine(directory, "azuredevops.pfx");
        await File.WriteAllBytesAsync(path, cert.Export(X509ContentType.Pfx, "pfx-password"));
        AnswerTokens();

        await OAuth(path, "pfx-password").ExchangeAsync(TrackerKinds.AzureDevOps, "the-code", "verifier", "https://inklayer.test/callback", default);
        Assert.NotNull(HttpUtility.ParseQueryString(Assert.Single(outbound.To(TokenUrl)).Body)["client_assertion"]);
    }

    [Fact]
    public async Task A_certificate_without_its_private_key_is_a_setup_error_and_nothing_is_sent()
    {
        using var key = RSA.Create(2048);
        using var cert = NewCertificate(key);
        var path = Path.Combine(directory, "public-only.pem");
        await File.WriteAllTextAsync(path, cert.ExportCertificatePem());

        var oauth = OAuth(path);
        await Assert.ThrowsAsync<TrackerOAuthSetupException>(() => oauth.RefreshAsync(TrackerKinds.AzureDevOps, "rt-1", null, default));
        await Assert.ThrowsAsync<TrackerOAuthSetupException>(() => OAuth(Path.Combine(directory, "missing.pem")).RefreshAsync(TrackerKinds.AzureDevOps, "rt-1", null, default));
        Assert.Empty(outbound.Requests);
    }

    private static string EntraToken(object claims) =>
        $"eyJhbGciOiJSUzI1NiJ9.{Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(claims)).TrimEnd('=').Replace('+', '-').Replace('/', '_')}.sig";

    [Fact]
    public async Task Who_connected_comes_from_the_Entra_token_without_asking_the_profile_service()
    {
        // A personal Microsoft account in a directory: no profile in Azure DevOps (VSS011031), so the token is what says who it is.
        outbound.Responders["https://app.vssps.visualstudio.com/"] = (_, _) => new HttpResponseMessage(HttpStatusCode.NotFound);
        var oauth = OAuth("", secret: "az-secret");
        var guest = await oauth.IdentifyAsync(TrackerKinds.AzureDevOps,
            EntraToken(new { oid = "oid-1", unique_name = "live.com#ana@gmail.example", name = "Ana" }), default);
        Assert.Equal(("oid-1", "ana@gmail.example"), (guest.Id, guest.Login));

        var member = await oauth.IdentifyAsync(TrackerKinds.AzureDevOps, EntraToken(new { oid = "oid-2", upn = "bo@acme.example", unique_name = "bo@acme.example" }), default);
        Assert.Equal(("oid-2", "bo@acme.example"), (member.Id, member.Login));
        Assert.Empty(outbound.Requests);

        // Not a token it can read: the profile service is asked, and its answer is the error.
        await Assert.ThrowsAsync<HttpRequestException>(() => oauth.IdentifyAsync(TrackerKinds.AzureDevOps, "opaque-token", default));
        Assert.Null(TrackerOAuth.EntraIdentity(EntraToken(new { name = "No object id" })));
    }
}
