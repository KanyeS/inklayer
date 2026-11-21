using System.Net;
using System.Net.Http.Headers;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Annotations;

public sealed record ContextConsoleDto(string Level, string Message);

public sealed record ContextNetworkDto(string Method, string Url, int Status);

public sealed record ContextDto(string Browser, int ViewportWidth, string Selector, string ElementHtml, List<ContextConsoleDto> Console, List<ContextNetworkDto> Network, double? Zoom = null);

public sealed record CommentWithContextDto(Guid Id, ContextDto? Context, bool HasScreenshot);

public sealed record PageWithContextDto(List<CommentWithContextDto> Annotations);

/// <summary>Screenshots and page details captured with a comment, for whoever fixes it.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class BugContextTests(InklayerApiFactory factory)
{
    /// <summary>The smallest valid WebP header, enough for the signature check.</summary>
    internal static readonly byte[] WebP = [(byte)'R', (byte)'I', (byte)'F', (byte)'F', 0x24, 0, 0, 0, (byte)'W', (byte)'E', (byte)'B', (byte)'P', (byte)'V', (byte)'P', (byte)'8', (byte)' ', 1, 2, 3];

    internal static object Context => new
    {
        browser = "Chrome 140", os = "macOS", userAgent = "Mozilla/5.0", viewportWidth = 1440, viewportHeight = 900, devicePixelRatio = 2.0, zoom = 1.25,
        selector = "main > button.pay", elementHtml = "<button class=\"pay\">Pay</button>",
        console = new[] { new { level = "error", message = "TypeError: price is undefined", at = DateTime.UtcNow } },
        network = new[] { new { method = "POST", url = "https://api.example.test/checkout?token=secret", status = 500, ms = 120, at = DateTime.UtcNow } },
    };

    internal static async Task<(HttpClient Admin, Guid ProjectId, HttpClient Author, HttpClient Other, HttpClient Viewer, string Url, Guid CommentId)> SetUpAsync(InklayerApiFactory factory)
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (author, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var (other, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Viewer");
        var url = $"https://site-{Guid.NewGuid():N}.example/checkout";
        using var created = await author.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new
        {
            url, kind = "Pin", body = "Pay button does nothing",
            anchor = new { element = new { path = new[] { "main > button.pay" }, tag = "button" } }, geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } }, viewportWidth = 1440,
        });
        return (admin, project.Id, author, other, viewer, url, (await created.ReadAsync<CommentWithContextDto>(HttpStatusCode.Created)).Id);
    }

    private static Task<HttpResponseMessage> PutScreenshotAsync(HttpClient client, Guid id, byte[] bytes, string type = "image/webp")
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(type);
        return client.PutAsync(new Uri($"/api/annotations/{id}/screenshot?width=800&height=400", UriKind.Relative), content);
    }

    [Fact]
    public async Task The_author_attaches_page_details_and_a_screenshot_that_viewers_can_see()
    {
        var (admin, _, author, other, viewer, url, id) = await SetUpAsync(factory);

        await other.PutJsonAsync($"/api/annotations/{id}/context", Context).ExpectAsync(HttpStatusCode.Forbidden);
        await author.PutJsonAsync($"/api/annotations/{id}/context", Context).ExpectAsync(HttpStatusCode.NoContent);
        await author.PutJsonAsync($"/api/annotations/{id}/context", Context).ExpectAsync(HttpStatusCode.Conflict);
        await PutScreenshotAsync(author, id, WebP).ExpectAsync(HttpStatusCode.NoContent);

        using var page = await viewer.GetAsync(new Uri($"/api/live/annotations?url={Uri.EscapeDataString(url)}", UriKind.Relative));
        var comment = Assert.Single(Assert.Single(await page.ReadAsync<List<PageWithContextDto>>()).Annotations);
        Assert.True(comment.HasScreenshot);
        Assert.Equal("main > button.pay", comment.Context!.Selector);
        Assert.Equal(1.25, comment.Context.Zoom);
        Assert.Equal("TypeError: price is undefined", Assert.Single(comment.Context.Console).Message);
        Assert.Equal("https://api.example.test/checkout", Assert.Single(comment.Context.Network).Url); // no query string, no token

        using var image = await viewer.GetAsync(new Uri($"/api/annotations/{id}/screenshot", UriKind.Relative));
        Assert.Equal(HttpStatusCode.OK, image.StatusCode);
        Assert.Equal("image/webp", image.Content.Headers.ContentType?.MediaType);
        Assert.Equal(WebP, await image.Content.ReadAsByteArrayAsync());

        var (outsiderAdmin, _, outsider, _, _, _, _) = await SetUpAsync(factory);
        await outsider.GetAsync(new Uri($"/api/annotations/{id}/screenshot", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        foreach (var c in new[] { admin, author, other, viewer, outsiderAdmin, outsider })
        {
            c.Dispose();
        }
    }

    [Fact]
    public async Task Screenshots_must_be_small_real_images()
    {
        var (admin, _, author, other, viewer, _, id) = await SetUpAsync(factory);

        await PutScreenshotAsync(author, id, "<svg onload=alert(1)>"u8.ToArray(), "image/svg+xml").ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        await PutScreenshotAsync(author, id, "not a jpeg"u8.ToArray(), "image/jpeg").ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        await PutScreenshotAsync(author, id, [.. WebP, .. new byte[700 * 1024]]).ExpectAsync(HttpStatusCode.RequestEntityTooLarge);
        foreach (var c in new[] { admin, author, other, viewer })
        {
            c.Dispose();
        }
    }
}
