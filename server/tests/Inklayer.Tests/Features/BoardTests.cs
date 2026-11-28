using System.Net;
using System.Net.Http.Headers;
using Inklayer.Api.Features.Docs;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

public sealed record BoardDocCardDto(Guid Id, string Title, string Kind, string Excerpt);

public sealed record BoardMediaDto(string Id);

/// <summary>
/// Boards are docs of kind "board": the same folders, access and live hub, with cards in their Yjs document instead of text,
/// and a markdown summary (the docs on them as [[links]], and their notes) for links, backlinks and search.
/// </summary>
[Collection(ApiTestGroup.Name)]
public sealed class BoardTests(InklayerApiFactory factory)
{
    private static readonly byte[] Png = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52, 1, 2, 3];

    private static Task<HttpResponseMessage> UploadAsync(HttpClient client, Guid boardId, byte[] bytes, string type = "image/png")
    {
        var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(type);
        return client.PostAsync(new Uri($"/api/boards/{boardId}/media", UriKind.Relative), content);
    }

    private async Task<(HttpClient Admin, Guid OrgId, HttpClient Ana, HttpClient Viewer, Guid BoardId)> BoardAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (ana, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        using var created = await ana.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = $"Board {Guid.NewGuid():N}", kind = "board" });
        return (admin, org.Id, ana, viewer, (await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created)).Id);
    }

    [Fact]
    public async Task Cards_describe_the_docs_on_a_board_that_the_caller_can_open()
    {
        var (admin, orgId, ana, viewer, boardId) = await BoardAsync();
        using var noteCreated = await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Notes" });
        var note = await noteCreated.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        await using (var live = await DocsProbe.ConnectAsync(factory, ana))
        {
            await live.OpenAsync(note.Id);
            var seq = await live.UpdateAsync(note.Id, 1);
            Assert.True(await live.SnapshotAsync(note.Id, [0xAA], "# Notes\n\n" + new string('x', 2000), seq));
        }

        // Another organisation's doc, not shared: left out.
        var other = await Scenario.CreateOrganizationAsync(admin);
        using var hiddenCreated = await admin.PostJsonAsync($"/api/orgs/{other.Id}/docs", new { title = "Secret" });
        var hidden = await hiddenCreated.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);

        using var cards = await viewer.PostJsonAsync($"/api/boards/{boardId}/cards", new { docIds = new[] { note.Id, hidden.Id, Guid.NewGuid() } });
        var card = Assert.Single(await cards.ReadAsync<List<BoardDocCardDto>>());
        Assert.Equal((note.Id, "doc"), (card.Id, card.Kind));
        Assert.StartsWith("# Notes", card.Excerpt, StringComparison.Ordinal);
        Assert.Equal(BoardEndpoints.ExcerptLength, card.Excerpt.Length);

        // Only boards have cards.
        await viewer.PostJsonAsync($"/api/boards/{note.Id}/cards", new { docIds = Array.Empty<Guid>() }).ExpectAsync(HttpStatusCode.NotFound);
        admin.Dispose();
        ana.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Commenters_add_pictures_to_a_board_that_everyone_who_can_see_it_can_load()
    {
        var (admin, _, ana, viewer, boardId) = await BoardAsync();
        await UploadAsync(viewer, boardId, Png).ExpectAsync(HttpStatusCode.Forbidden);
        await UploadAsync(ana, boardId, Png, "image/svg+xml").ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        await UploadAsync(ana, boardId, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        await UploadAsync(ana, boardId, new byte[BoardEndpoints.MaxImageBytes + 1]).ExpectAsync(HttpStatusCode.RequestEntityTooLarge);

        using var uploaded = await UploadAsync(ana, boardId, Png);
        var media = await uploaded.ReadAsync<BoardMediaDto>(HttpStatusCode.Created);
        Assert.EndsWith(".png", media.Id, StringComparison.Ordinal);

        using (var image = await viewer.GetAsync(new Uri($"/api/boards/{boardId}/media/{media.Id}", UriKind.Relative)))
        {
            Assert.Equal(HttpStatusCode.OK, image.StatusCode);
            Assert.Equal("image/png", image.Content.Headers.ContentType?.MediaType);
            Assert.Equal("nosniff", image.Headers.GetValues("X-Content-Type-Options").Single());
            Assert.Equal(Png, await image.Content.ReadAsByteArrayAsync());
        }

        await viewer.GetAsync(new Uri($"/api/boards/{boardId}/media/../secret", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        var elsewhere = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, elsewhere.Id, "Commenter");
        await outsider.GetAsync(new Uri($"/api/boards/{boardId}/media/{media.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        outsider.Dispose();
        admin.Dispose();
        ana.Dispose();
        viewer.Dispose();
    }

    [Theory]
    [InlineData("127.0.0.1", false)]
    [InlineData("10.1.2.3", false)]
    [InlineData("172.20.0.1", false)]
    [InlineData("192.168.1.1", false)]
    [InlineData("169.254.169.254", false)]
    [InlineData("100.64.0.1", false)]
    [InlineData("0.0.0.0", false)]
    [InlineData("224.0.0.1", false)]
    [InlineData("::1", false)]
    [InlineData("fd00::1", false)]
    [InlineData("fe80::1", false)]
    [InlineData("::ffff:127.0.0.1", false)]
    [InlineData("::ffff:169.254.169.254", false)]
    [InlineData("93.184.216.34", true)]
    [InlineData("2606:4700::1111", true)]
    public void Link_previews_connect_only_to_public_addresses(string address, bool allowed) =>
        Assert.Equal(allowed, LinkPreviewer.IsPublic(System.Net.IPAddress.Parse(address)));

    [Fact]
    public void Link_previews_read_opengraph_tags_then_the_title()
    {
        var page = new Uri("https://example.com/blog/post");
        const string html = """
            <html><head><title>Fallback</title><meta property="og:title" content="Ship &amp; tell"><meta content='A  short
            description' name="description"><meta property="og:image" content="/img/cover.png"></head></html>
            """;
        var og = LinkPreviewer.Parse(html, page);
        Assert.Equal(("Ship & tell", "A short description", "https://example.com/img/cover.png"), (og.Title, og.Description, og.Image));

        var plain = LinkPreviewer.Parse("<title>Just a title</title><meta property=\"og:image\" content=\"javascript:alert(1)\">", page);
        Assert.Equal(("Just a title", null, null), (plain.Title, plain.Description, plain.Image));
    }

    [Fact]
    public async Task Link_previews_refuse_private_addresses()
    {
        var (admin, _, ana, viewer, boardId) = await BoardAsync();
        await viewer.GetAsync(new Uri($"/api/boards/{boardId}/link-preview?url=https://example.com", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await ana.GetAsync(new Uri($"/api/boards/{boardId}/link-preview?url=file:///etc/passwd", UriKind.Relative)).ExpectAsync(HttpStatusCode.BadRequest);
        using var local = await ana.GetAsync(new Uri($"/api/boards/{boardId}/link-preview?url={Uri.EscapeDataString("http://127.0.0.1:1/x")}", UriKind.Relative));
        var preview = await local.ReadAsync<LinkPreviewResponse>();
        Assert.Equal((null, null), (preview.Title, preview.Image)); // nothing read from it
        admin.Dispose();
        ana.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task A_board_is_a_doc_of_its_own_kind_whose_summary_links_the_docs_on_it()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (ana, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        using var roadmapCreated = await ana.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Roadmap", folder = "Plans" });
        var roadmap = await roadmapCreated.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        using var boardCreated = await ana.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Launch board", kind = "board" });
        var board = await boardCreated.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        Assert.Equal("board", board.Kind);

        await ana.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Odd", kind = "spreadsheet" }).ExpectAsync(HttpStatusCode.BadRequest);

        await using (var live = await DocsProbe.ConnectAsync(factory, ana))
        {
            var opened = await live.OpenAsync(board.Id);
            Assert.True(opened.CanEdit);
            var seq = await live.UpdateAsync(board.Id, 1, 2, 3);
            Assert.True(await live.SnapshotAsync(board.Id, [0xAA], "[[Plans/Roadmap]]\n\nShip the beta #launch", seq));
        }

        using (var tree = await ana.GetAsync(new Uri($"/api/orgs/{org.Id}/docs", UriKind.Relative)))
        {
            var docs = (await tree.ReadAsync<DocTreeDto>()).Docs;
            Assert.Equal("board", docs.Single(d => d.Id == board.Id).Kind);
            Assert.Equal("doc", docs.Single(d => d.Id == roadmap.Id).Kind);
        }

        using (var details = await ana.GetAsync(new Uri($"/api/docs/{roadmap.Id}", UriKind.Relative)))
        {
            var backlink = Assert.Single((await details.ReadAsync<DocDto>()).Backlinks);
            Assert.Equal((board.Id, "board"), (backlink.Id, backlink.Kind));
        }

        using (var graph = await ana.GetAsync(new Uri($"/api/orgs/{org.Id}/docs/graph", UriKind.Relative)))
        {
            var nodes = (await graph.ReadAsync<DocGraphDto>()).Nodes;
            Assert.True(nodes.Single(n => n.Id == $"d:{board.Id}").Board);
            Assert.False(nodes.Single(n => n.Id == $"d:{roadmap.Id}").Board);
        }

        using (var search = await ana.GetAsync(new Uri($"/api/orgs/{org.Id}/docs/search?q=beta", UriKind.Relative)))
        {
            Assert.Contains(board.Id, (await search.ReadAsync<List<DocSearchDto>>()).Select(r => r.Id));
        }

        ana.Dispose();
    }
}
