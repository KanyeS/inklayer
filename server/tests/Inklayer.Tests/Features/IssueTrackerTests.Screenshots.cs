using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Inklayer.Api.Features.Issues;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

/// <summary>A comment's screenshot shown in the issue made from it, from a public address that ends with the comment.</summary>
public sealed partial class IssueTrackerTests
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4];

    [Fact]
    public async Task Screenshots_show_in_issues_from_a_public_address_that_stops_working_when_the_comment_goes()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Repo = "https://api.github.com/repos/acme/shots";
        factory.Outbound.Responders[Repo] = (_, _) => Json(new { has_issues = true, permissions = new { push = true } });
        factory.Outbound.Responders[$"{Repo}/issues"] = (_, _) => Json(new { number = 4, html_url = "https://github.com/acme/shots/issues/4" }, HttpStatusCode.Created);
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "github", token = "ghp", settings = new { owner = "acme", repo = "shots" } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);

        var comment = await CommentAsync(ana, projectId, "Hero image is cropped");
        using (var content = new ByteArrayContent(Png))
        {
            content.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            await ana.PutAsync(new Uri($"/api/annotations/{comment}/screenshot?width=800&height=400", UriKind.Relative), content).ExpectAsync(HttpStatusCode.NoContent);
        }

        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        var body = JsonDocument.Parse(factory.Outbound.To($"{Repo}/issues").Single(r => r.Request.Method == HttpMethod.Post).Body).RootElement.GetProperty("body").GetString()!;
        var image = Regex.Match(body, @"!\[Screenshot\]\((http://localhost(/media/[A-Za-z0-9_-]{43}\.png))\)");
        Assert.True(image.Success, body);

        // Anyone can fetch it (a tracker showing it, say), with no sign-in; it can't be run or indexed.
        using var anyone = factory.CreateClient();
        using (var fetched = await anyone.GetAsync(new Uri(image.Groups[2].Value, UriKind.Relative)))
        {
            Assert.Equal(HttpStatusCode.OK, fetched.StatusCode);
            Assert.Equal("image/png", fetched.Content.Headers.ContentType!.MediaType);
            Assert.Equal(Png, await fetched.Content.ReadAsByteArrayAsync());
            Assert.Equal("nosniff", fetched.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Contains("sandbox", fetched.Headers.GetValues("Content-Security-Policy").Single(), StringComparison.Ordinal);
        }

        await anyone.GetAsync(new Uri("/media/not-a-token.png", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await anyone.GetAsync(new Uri($"/media/{new string('A', 43)}.png", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        // The comment deleted: the address stops working.
        using (var deleted = await ana.DeleteAsync(new Uri($"/api/annotations/{comment}?version=1", UriKind.Relative)))
        {
            Assert.True(deleted.IsSuccessStatusCode, await deleted.Content.ReadAsStringAsync());
        }

        await anyone.GetAsync(new Uri(image.Groups[2].Value, UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public void Azure_DevOps_gets_images_as_img_tags_and_links_as_links()
    {
        var html = Trackers.HtmlFromText("**Screenshot:**\n![Screenshot](https://ink.test/media/abc.png)\n[View](https://ink.test/c/1)");
        Assert.Contains("<img src=\"https://ink.test/media/abc.png\" alt=\"Screenshot\">", html, StringComparison.Ordinal);
        Assert.Contains("<a href=\"https://ink.test/c/1\">View</a>", html, StringComparison.Ordinal);
        Assert.DoesNotContain("!<a", html, StringComparison.Ordinal);
    }
}
