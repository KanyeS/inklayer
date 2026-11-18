using System.Collections.Concurrent;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;

namespace Inklayer.Tests.Infrastructure;

/// <summary>
/// An in-memory OpenID Connect provider, plugged into the OIDC handler's backchannel. It answers discovery, the signing
/// keys, the token endpoint and userinfo, so tests run the real handler end to end: redirect, code exchange, ID token
/// validation and the userinfo call. Like JumpCloud with default settings, the ID token carries only <c>sub</c>; email
/// and name come from userinfo.
/// </summary>
public sealed class FakeOidcProvider : HttpMessageHandler
{
    public const string Issuer = "https://idp.example.test/";
    public const string ClientId = "oidc-client";

    private readonly RSA _rsa = RSA.Create(2048);
    private readonly ConcurrentDictionary<string, (string Nonce, Dictionary<string, object> UserInfo)> _codes = new();
    private readonly ConcurrentDictionary<string, Dictionary<string, object>> _accessTokens = new();

    /// <summary>Issues an authorization code for the person described by <paramref name="userInfo"/> (must include <c>sub</c>).</summary>
    public string IssueCode(string nonce, Dictionary<string, object> userInfo)
    {
        var code = Guid.NewGuid().ToString("N");
        _codes[code] = (nonce, userInfo);
        return code;
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri!.AbsolutePath;
        return path switch
        {
            "/.well-known/openid-configuration" => Json(new Dictionary<string, object>
            {
                ["issuer"] = Issuer,
                ["authorization_endpoint"] = Issuer + "authorize",
                ["token_endpoint"] = Issuer + "token",
                ["userinfo_endpoint"] = Issuer + "userinfo",
                ["jwks_uri"] = Issuer + "jwks",
                ["response_types_supported"] = new[] { "code" },
                ["subject_types_supported"] = new[] { "public" },
                ["id_token_signing_alg_values_supported"] = new[] { "RS256" },
            }),
            "/jwks" => Jwks(),
            "/token" => await TokenAsync(request, cancellationToken),
            "/userinfo" => UserInfo(request),
            _ => new HttpResponseMessage(HttpStatusCode.NotFound),
        };
    }

    private async Task<HttpResponseMessage> TokenAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var form = (await request.Content!.ReadAsStringAsync(cancellationToken))
            .Split('&').Select(p => p.Split('=', 2)).ToDictionary(p => Uri.UnescapeDataString(p[0]), p => Uri.UnescapeDataString(p[1].Replace('+', ' ')));
        if (!form.TryGetValue("code", out var code) || !_codes.TryRemove(code, out var grant) || !form.ContainsKey("code_verifier"))
        {
            return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = new StringContent("""{"error":"invalid_grant"}""", Encoding.UTF8, "application/json") };
        }

        var now = DateTime.UtcNow;
        var idToken = new JsonWebTokenHandler().CreateToken(new SecurityTokenDescriptor
        {
            Issuer = Issuer,
            Audience = ClientId,
            IssuedAt = now,
            NotBefore = now,
            Expires = now.AddMinutes(5),
            Claims = new Dictionary<string, object> { ["sub"] = grant.UserInfo["sub"], ["nonce"] = grant.Nonce },
            SigningCredentials = new SigningCredentials(new RsaSecurityKey(_rsa) { KeyId = "test-key" }, SecurityAlgorithms.RsaSha256),
        });

        var accessToken = Guid.NewGuid().ToString("N");
        _accessTokens[accessToken] = grant.UserInfo;
        return Json(new Dictionary<string, object> { ["access_token"] = accessToken, ["token_type"] = "Bearer", ["expires_in"] = 300, ["id_token"] = idToken });
    }

    private HttpResponseMessage UserInfo(HttpRequestMessage request) =>
        request.Headers.Authorization is { Scheme: "Bearer", Parameter: { } token } && _accessTokens.TryGetValue(token, out var userInfo)
            ? Json(userInfo)
            : new HttpResponseMessage(HttpStatusCode.Unauthorized);

    private HttpResponseMessage Jwks()
    {
        var parameters = _rsa.ExportParameters(includePrivateParameters: false);
        return Json(new Dictionary<string, object>
        {
            ["keys"] = new[]
            {
                new Dictionary<string, string>
                {
                    ["kty"] = "RSA", ["use"] = "sig", ["alg"] = "RS256", ["kid"] = "test-key",
                    ["n"] = Base64UrlEncoder.Encode(parameters.Modulus), ["e"] = Base64UrlEncoder.Encode(parameters.Exponent),
                },
            },
        });
    }

    private static HttpResponseMessage Json(object body) =>
        new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json") };

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _rsa.Dispose();
        }

        base.Dispose(disposing);
    }
}
