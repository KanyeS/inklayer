using System.Net;
using System.Text.Json;
using Inklayer.Api.Features.Docs;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record ShareDto(Guid Id, string Kind, string Url, Guid? ProjectId, string? PageUrl, Guid? DocId, bool IncludeResolved, string CreatedBy,
    DateTime? ExpiresAt, bool Expired, int ViewCount, bool CanRevoke);

public sealed record PublicReplyDto(string Author, string Body);

public sealed record PublicCommentDto(Guid Id, string Body, string Status, string Author, bool HasScreenshot, List<PublicReplyDto> Replies);

public sealed record PublicPageDto(string PageUrl, List<PublicCommentDto> Comments);

public sealed record PublicDocLinkDto(string Key, string Token);

public sealed record PublicDocDto(string Markdown, List<PublicDocLinkDto> Links);

public sealed record PublicShareDto(string Kind, string Title, List<PublicPageDto>? Pages, PublicDocDto? Doc);

/// <summary>Read-only links for people without an account: page, project and doc shares.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class SharingTests(InklayerApiFactory factory)
{
    private static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

    internal static string TokenOf(ShareDto share) => share.Url[(share.Url.LastIndexOf('/') + 1)..];

    private async Task<(HttpClient Admin, Guid OrgId, Guid ProjectId, HttpClient Ana, MeDto AnaMe, HttpClient Ben, HttpClient Viewer)> OrgAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (ana, anaMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (ben, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        return (admin, org.Id, project.Id, ana, anaMe, ben, viewer);
    }

    private static async Task<Guid> CommentAsync(HttpClient client, Guid projectId, string url, string body)
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations", new
        {
            url, kind = "Pin", body,
            anchor = new { element = new { path = new[] { "h1" }, tag = "h1" } }, geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } }, viewportWidth = 1200,
        });
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return json.RootElement.GetProperty("id").GetGuid();
    }

    private HttpClient Guest() => factory.CreateClient(new() { AllowAutoRedirect = false, HandleCookies = false });

    private static async Task<ShareDto> ShareAsync(HttpClient client, object request, HttpStatusCode expected = HttpStatusCode.Created)
    {
        using var response = await client.PostJsonAsync("/api/shares", request);
        return await response.ReadAsync<ShareDto>(expected);
    }

    [Fact]
    public async Task Guests_see_one_pages_open_comments_with_names_only()
    {
        var (admin, _, projectId, ana, anaMe, ben, viewer) = await OrgAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = ben;
        using var _d = viewer;
        var site = $"https://site-{Guid.NewGuid():N}.example";
        var open = await CommentAsync(ana, projectId, $"{site}/checkout", $"Button overlaps <@{anaMe.Id}>");
        await ben.PostJsonAsync($"/api/annotations/{open}/replies", new { body = "Seen it" }).ExpectAsync(HttpStatusCode.Created);
        var resolved = await CommentAsync(ana, projectId, $"{site}/checkout", "Old typo");
        await ana.PatchJsonAsync($"/api/annotations/{resolved}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        await CommentAsync(ana, projectId, $"{site}/other", "Elsewhere");

        await viewer.PostJsonAsync("/api/shares", new { kind = "page", projectId, pageUrl = $"{site}/checkout" }).ExpectAsync(HttpStatusCode.Forbidden);
        var share = await ShareAsync(ana, new { kind = "page", projectId, pageUrl = $"{site}/checkout?utm=x" });
        Assert.StartsWith("http://localhost/s/", share.Url, StringComparison.Ordinal);

        using var guest = Guest();
        using var response = await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(share)}", UriKind.Relative));
        Assert.Equal(("noindex, nofollow", "no-referrer"), (response.Headers.GetValues("X-Robots-Tag").Single(), response.Headers.GetValues("Referrer-Policy").Single()));
        var text = await response.Content.ReadAsStringAsync();
        Assert.DoesNotContain("@", text.Replace($"@{anaMe.DisplayName}", "", StringComparison.Ordinal), StringComparison.Ordinal); // no emails anywhere
        var shared = JsonSerializer.Deserialize<PublicShareDto>(text, Web)!;
        var page = Assert.Single(shared.Pages!);
        var comment = Assert.Single(page.Comments);
        Assert.Equal((open, $"Button overlaps @{anaMe.DisplayName}", anaMe.DisplayName), (comment.Id, comment.Body, comment.Author));
        Assert.Equal("Seen it", Assert.Single(comment.Replies).Body);

        // Including resolved comments; the screenshot route only serves comments in the share.
        var all = await ShareAsync(ana, new { kind = "project", projectId, includeResolved = true });
        using (var everything = await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(all)}", UriKind.Relative)))
        {
            Assert.Equal(3, (await everything.ReadAsync<PublicShareDto>()).Pages!.Sum(p => p.Comments.Count));
        }

        await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(share)}/screenshots/{resolved}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        using var list = await ben.GetAsync(new Uri($"/api/shares?projectId={projectId}", UriKind.Relative));
        var listed = await list.ReadAsync<List<ShareDto>>();
        Assert.Equal(1, listed.Single(s => s.Id == share.Id).ViewCount);
        Assert.False(listed.Single(s => s.Id == share.Id).CanRevoke); // Ben didn't make it and isn't a project Admin
    }

    [Fact]
    public async Task Revoked_and_expired_links_stop_working()
    {
        var (admin, _, projectId, ana, _, ben, viewer) = await OrgAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = ben;
        using var _d = viewer;
        await CommentAsync(ana, projectId, "https://shop.example/", "Hello");
        var share = await ShareAsync(ana, new { kind = "project", projectId });
        var expiring = await ShareAsync(ana, new { kind = "project", projectId, expiresInDays = 7 });
        using var guest = Guest();
        await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(share)}", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);

        await ben.DeleteAsync(new Uri($"/api/shares/{share.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await ana.DeleteAsync(new Uri($"/api/shares/{share.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        using (var gone = await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(share)}", UriKind.Relative)))
        {
            Assert.Equal(HttpStatusCode.NotFound, gone.StatusCode);
            Assert.Contains("doesn't work any more", await gone.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        }

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            await db.ShareLinks.Where(s => s.Id == expiring.Id).ExecuteUpdateAsync(u => u.SetProperty(s => s.ExpiresAt, DateTime.UtcNow.AddMinutes(-1)));
        }

        await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(expiring)}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await guest.GetAsync(new Uri("/api/public/shares/not-a-real-token-at-all-0000", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await ana.PostJsonAsync("/api/shares", new { kind = "project", projectId, expiresInDays = 0 }).ExpectAsync(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Public_docs_link_to_other_public_docs_only()
    {
        var (admin, orgId, _, ana, anaMe, ben, viewer) = await OrgAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = ben;
        using var _d = viewer;
        async Task<Guid> DocAsync(string title, string markdown)
        {
            using var created = await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title });
            var id = (await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created)).Id;
            await using var scope = factory.Services.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<DocText>().EditAsync(id, anaMe.Id, _ => [new TextEdit(0, 0, markdown)], CancellationToken.None);
            return id;
        }

        var handbook = await DocAsync("Handbook", $"Owner <@{anaMe.Id}>. See [[Style guide]] and [[Secrets]].");
        var style = await DocAsync("Style guide", "Use sentence case.");
        await DocAsync("Secrets", "Not for guests.");

        await viewer.PostJsonAsync("/api/shares", new { kind = "doc", docId = handbook }).ExpectAsync(HttpStatusCode.Forbidden);
        var shared = await ShareAsync(ana, new { kind = "doc", docId = handbook });
        Assert.Equal(shared.Id, (await ShareAsync(ben, new { kind = "doc", docId = handbook }, HttpStatusCode.OK)).Id); // one link per doc
        var styleShare = await ShareAsync(ana, new { kind = "doc", docId = style });

        using var guest = Guest();
        using var response = await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(shared)}", UriKind.Relative));
        var doc = await response.ReadAsync<PublicShareDto>();
        Assert.Equal(("doc", "Handbook"), (doc.Kind, doc.Title));
        Assert.Equal($"Owner @{anaMe.DisplayName}. See [[Style guide]] and [[Secrets]].", doc.Doc!.Markdown);
        Assert.Equal([new PublicDocLinkDto("style guide", TokenOf(styleShare))], doc.Doc.Links);

        // Viewers see the doc's link; Commenters can turn it off.
        using (var list = await viewer.GetAsync(new Uri($"/api/shares?docId={handbook}", UriKind.Relative)))
        {
            Assert.False(Assert.Single(await list.ReadAsync<List<ShareDto>>()).CanRevoke);
        }

        await ben.DeleteAsync(new Uri($"/api/shares/{shared.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        await guest.GetAsync(new Uri($"/api/public/shares/{TokenOf(shared)}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
    }
}
