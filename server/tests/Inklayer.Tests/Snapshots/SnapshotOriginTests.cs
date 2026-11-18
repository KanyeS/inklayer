using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Snapshots;

/// <summary>The separate origin that serves captured pages.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class SnapshotOriginTests(InklayerApiFactory factory)
{
    private async Task<SnapshotDto> CaptureAsync(string bodyHtml = "<h1>Hello</h1>")
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        return await Capture.SnapshotAsync(admin, project.Id, bodyHtml);
    }

    [Fact]
    public async Task Serves_the_sanitized_page_with_a_locked_down_policy()
    {
        var snapshot = await CaptureAsync("<h1>Hello</h1><script>alert(document.cookie)</script><img src=x onerror=alert(1)>");
        using var anonymous = factory.CreateClient();

        using var response = await anonymous.GetAsync(snapshot.ViewUrl);
        var html = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType!.MediaType);
        Assert.Contains("<h1>Hello</h1>", html, StringComparison.Ordinal);
        Assert.DoesNotContain("alert(", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("onerror", html, StringComparison.OrdinalIgnoreCase);

        var csp = string.Join(";", response.Headers.GetValues("Content-Security-Policy"));
        Assert.Contains("default-src 'none'", csp, StringComparison.Ordinal);
        Assert.Contains("connect-src 'none'", csp, StringComparison.Ordinal);
        Assert.Contains("frame-ancestors http://localhost", csp, StringComparison.Ordinal);
        Assert.Equal("nosniff", response.Headers.GetValues("X-Content-Type-Options").Single());

        // Only Inklayer's overlay may run, through a per-response nonce, in a sandbox without allow-same-origin.
        var nonce = System.Text.RegularExpressions.Regex.Match(csp, "script-src 'nonce-([^']+)'").Groups[1].Value;
        Assert.NotEmpty(nonce);
        Assert.Contains("sandbox allow-scripts", csp, StringComparison.Ordinal);
        Assert.DoesNotContain("allow-same-origin", csp, StringComparison.Ordinal);
        Assert.Contains($"<script nonce=\"{nonce}\" src=\"/_inklayer/overlay.js", html, StringComparison.Ordinal);
        Assert.Contains("data-app-origin=\"http://localhost\"", html, StringComparison.Ordinal);
        Assert.Single(System.Text.RegularExpressions.Regex.Matches(html, "<script"));
    }

    [Fact]
    public async Task Each_response_gets_a_fresh_nonce()
    {
        var snapshot = await CaptureAsync();
        using var anonymous = factory.CreateClient();

        using var first = await anonymous.GetAsync(snapshot.ViewUrl);
        using var second = await anonymous.GetAsync(snapshot.ViewUrl);

        Assert.NotEqual(first.Headers.GetValues("Content-Security-Policy").Single(), second.Headers.GetValues("Content-Security-Policy").Single());
    }

    [Fact]
    public async Task Assets_load_inside_the_sandboxed_page()
    {
        var snapshot = await CaptureAsync();
        using var anonymous = factory.CreateClient();

        using var response = await anonymous.GetAsync(new Uri(snapshot.ViewUrl!, $"a/{Capture.Hash(Capture.Png)}"));

        // The sandboxed page has an opaque origin: fonts need CORS, and a same-origin resource policy would block images.
        Assert.Equal("*", response.Headers.GetValues("Access-Control-Allow-Origin").Single());
        Assert.Equal("cross-origin", response.Headers.GetValues("Cross-Origin-Resource-Policy").Single());
        Assert.Contains("sandbox", response.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Serves_referenced_assets_under_the_same_link()
    {
        var snapshot = await CaptureAsync();
        using var anonymous = factory.CreateClient();

        using var response = await anonymous.GetAsync(new Uri(snapshot.ViewUrl!, $"a/{Capture.Hash(Capture.Png)}"));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("image/png", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal(Capture.Png, await response.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task Assets_from_other_snapshots_cannot_be_fetched_through_a_link()
    {
        var mine = await CaptureAsync();
        using var anonymous = factory.CreateClient();
        var someoneElsesAsset = new string('c', 64);

        await anonymous.GetAsync(new Uri(mine.ViewUrl!, $"a/{someoneElsesAsset}")).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Tampered_or_mismatched_tokens_are_rejected()
    {
        var first = await CaptureAsync();
        var second = await CaptureAsync();
        using var anonymous = factory.CreateClient();
        var firstToken = first.ViewUrl!.Segments[3].TrimEnd('/');

        await anonymous.GetAsync(new Uri($"{InklayerApiFactory.SnapshotOrigin}/s/{second.Id}/{firstToken}/")).ExpectAsync(HttpStatusCode.NotFound);
        await anonymous.GetAsync(new Uri($"{InklayerApiFactory.SnapshotOrigin}/s/{first.Id}/{firstToken}x/")).ExpectAsync(HttpStatusCode.NotFound);
        await anonymous.GetAsync(new Uri($"{InklayerApiFactory.SnapshotOrigin}/s/{first.Id}/not-a-token/")).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task The_app_origin_never_serves_captured_pages()
    {
        var snapshot = await CaptureAsync();
        using var client = factory.CreateClient();

        await client.GetAsync(new Uri(snapshot.ViewUrl!.PathAndQuery, UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task The_snapshot_origin_serves_nothing_but_snapshots()
    {
        using var client = factory.CreateClient();

        await client.GetAsync(new Uri($"{InklayerApiFactory.SnapshotOrigin}/api/me")).ExpectAsync(HttpStatusCode.NotFound);
        await client.GetAsync(new Uri($"{InklayerApiFactory.SnapshotOrigin}/auth/login")).ExpectAsync(HttpStatusCode.NotFound);
        await client.GetAsync(new Uri($"{InklayerApiFactory.SnapshotOrigin}/openapi/v1.json")).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Missing_trailing_slash_redirects_so_relative_assets_resolve()
    {
        var snapshot = await CaptureAsync();
        using var client = factory.CreateClient(new() { AllowAutoRedirect = false });
        var withoutSlash = snapshot.ViewUrl!.ToString().TrimEnd('/');

        using var response = await client.GetAsync(new Uri(withoutSlash));

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.EndsWith("/", response.Headers.Location!.ToString(), StringComparison.Ordinal);
    }
}
