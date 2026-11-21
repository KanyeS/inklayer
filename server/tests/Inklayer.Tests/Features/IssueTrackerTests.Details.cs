using System.Net;
using System.Text.Json;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

/// <summary>What an issue says about where a comment came from: links, when, the page's build, and the network.</summary>
public sealed partial class IssueTrackerTests
{
    private static async Task<Guid> CommentWithDetailsAsync(HttpClient client, Guid projectId, string body, string fromAddress)
    {
        var comment = await CommentAsync(client, projectId, body);
        using var request = new HttpRequestMessage(HttpMethod.Put, $"/api/annotations/{comment}/context")
        {
            Content = System.Net.Http.Json.JsonContent.Create(new
            {
                browser = "Firefox 158", os = "Linux", userAgent = "Mozilla/5.0", viewportWidth = 1835, viewportHeight = 995, devicePixelRatio = 1,
                selector = "#app > main", elementHtml = "<main></main>", console = Array.Empty<object>(), network = Array.Empty<object>(),
                timeZone = "Australia/Brisbane", utcOffsetMinutes = 600,
                scripts = new[] { "main.3f2a9c1e.js", "vendor.ab12cd.js?v=2", "main.3f2a9c1e.js" },
            }),
        };
        request.Headers.Add(InklayerApiFactory.ClientIpHeader, fromAddress);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        return comment;
    }

    [Fact]
    public async Task Issues_link_the_page_and_comment_and_say_when_on_which_build_and_from_which_network()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Repo = "https://api.github.com/repos/acme/details";
        factory.Outbound.Responders[Repo] = (_, _) => Json(new { has_issues = true, permissions = new { push = true } });
        factory.Outbound.Responders[$"{Repo}/issues"] = (_, _) => Json(new { number = 5, html_url = "https://github.com/acme/details/issues/5" }, HttpStatusCode.Created);
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "github", token = "ghp", settings = new { owner = "acme", repo = "details" } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var comment = await CommentWithDetailsAsync(ana, projectId, "Broken after the redesign, see https://status.example/incident/12.", "203.0.113.7");

        // The page details say it too.
        var details = (await CommentJsonAsync(viewer, comment)).GetProperty("context");
        Assert.Equal(("NordVPN S.A.", "Netherlands", "vpn"), (details.GetProperty("ipNetwork").GetString(), details.GetProperty("ipCountry").GetString(), details.GetProperty("ipNetworkKind").GetString()));
        Assert.Equal(["main.3f2a9c1e.js", "vendor.ab12cd.js"], details.GetProperty("scripts").EnumerateArray().Select(e => e.GetString()));
        Assert.DoesNotContain("203.0.113.7", details.GetRawText(), StringComparison.Ordinal);

        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        var body = JsonDocument.Parse(factory.Outbound.To($"{Repo}/issues").Single(x => x.Request.Method == HttpMethod.Post).Body).RootElement.GetProperty("body").GetString()!;
        Assert.Contains("**Page:** [https://shop.example/checkout](https://shop.example/checkout)", body, StringComparison.Ordinal);
        Assert.Contains($"in Inklayer: [http://localhost/comments/{comment}](http://localhost/comments/{comment})", body, StringComparison.Ordinal);
        Assert.Matches(@"\*\*Commented:\*\* \d{1,2} \w{3} \d{4}, \d{2}:\d{2} \(Australia/Brisbane, UTC\+10:00\)", body);
        Assert.Contains("**Page build:** `main.3f2a9c1e.js`, `vendor.ab12cd.js`", body, StringComparison.Ordinal);
        Assert.Contains("**Network:** NordVPN S.A. (Netherlands), likely a VPN", body, StringComparison.Ordinal);
        Assert.Contains("https://status.example/incident/12", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Azure_DevOps_and_Jira_get_bare_addresses_as_links()
    {
        var html = Inklayer.Api.Features.Issues.Trackers.HtmlFromText("See https://status.example/incident/12. And **[the page](https://shop.example/a?x=1&y=2)**, `#app`");
        Assert.Contains("<a href=\"https://status.example/incident/12\">https://status.example/incident/12</a>.", html, StringComparison.Ordinal);
        Assert.Contains("<b><a href=\"https://shop.example/a?x=1&amp;y=2\">the page</a></b>", html, StringComparison.Ordinal);
        Assert.Contains("<code>#app</code>", html, StringComparison.Ordinal);
    }

    [Fact]
    public void Times_are_in_the_commenters_zone_or_offset_or_UTC()
    {
        var at = new DateTime(2026, 11, 21, 11, 32, 0, DateTimeKind.Utc);
        Assert.Equal("21 Nov 2026, 21:32 (Australia/Brisbane, UTC+10:00)",
            Inklayer.Api.Features.Issues.IssueService.When(at, new() { AnnotationId = Guid.Empty, TimeZone = "Australia/Brisbane" }));
        Assert.Equal("21 Nov 2026, 06:32 (UTC-05:00)", Inklayer.Api.Features.Issues.IssueService.When(at, new() { AnnotationId = Guid.Empty, UtcOffsetMinutes = -300 }));
        Assert.Equal("21 Nov 2026, 11:32 (UTC)", Inklayer.Api.Features.Issues.IssueService.When(at, null));
    }
}
