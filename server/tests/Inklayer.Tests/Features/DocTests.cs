using System.Net;
using System.Text.Json;
using Inklayer.Api.Features.Docs;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record DocSummaryDto(Guid Id, string Folder, string Title, List<string> Tags, string? Icon = null, string? Color = null);

public sealed record DocTreeDto(List<string> Folders, List<DocSummaryDto> Docs, bool CanEdit, List<DocTagDto>? Tags = null);

public sealed record DocLinkDto(string Text, Guid? DocId, string? Title);

public sealed record DocCommentLinkDto(Guid AnnotationId, string Body);

public sealed record DocDto(
    Guid Id, string Folder, string Title, int Version, bool CanEdit, List<string> Tags, List<DocSummaryDto> Backlinks,
    List<DocCommentLinkDto> CommentBacklinks, List<DocLinkDto> Links, List<Guid> CommentLinks, string? Icon = null, string? Color = null);

public sealed record DocChangedDto(DocDto Doc, List<Guid> RelinkDocs);

public sealed record DocSearchDto(Guid Id, string Title, string Snippet);

public sealed record DocTagDto(string Tag, int Count, string? Icon = null, string? Color = null);

public sealed record DocGraphDto(List<DocGraphNodeDto> Nodes, List<DocGraphEdgeDto> Edges);

public sealed record DocGraphNodeDto(string Id, string Kind, string Label, string? Icon = null, string? Color = null);

public sealed record DocGraphEdgeDto(string Source, string Target);

public sealed record DocRevisionDto(int Version, string Action, string Title);

[Collection(ApiTestGroup.Name)]
public sealed class DocTests(InklayerApiFactory factory)
{
    private async Task<(HttpClient Admin, Guid OrgId, HttpClient Commenter, HttpClient Viewer)> OrgAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (commenter, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        return (admin, org.Id, commenter, viewer);
    }

    private static async Task<DocSummaryDto> CreateAsync(HttpClient client, Guid orgId, string title, string folder = "")
    {
        using var response = await client.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title, folder });
        return await response.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
    }

    private static async Task<DocDto> GetAsync(HttpClient client, Guid docId)
    {
        using var response = await client.GetAsync(new Uri($"/api/docs/{docId}", UriKind.Relative));
        return await response.ReadAsync<DocDto>();
    }

    /// <summary>Stands in for an editor's snapshot through the docs hub.</summary>
    private async Task WriteAsync(Guid docId, string markdown)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var doc = await db.Docs.SingleAsync(d => d.Id == docId);
        doc.Content = markdown;
        await db.SaveChangesAsync();
        await scope.ServiceProvider.GetRequiredService<DocIndexer>().IndexDocAsync(doc, CancellationToken.None);
        await db.SaveChangesAsync();
    }

    [Fact]
    public async Task Everyone_in_the_organisation_reads_docs_and_commenters_edit_them()
    {
        var (admin, orgId, commenter, viewer) = await OrgAsync();
        var (_, _, outsider, _) = await OrgAsync(); // a member of another organisation

        var doc = await CreateAsync(commenter, orgId, "Roadmap", "Planning");
        await viewer.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Nope" }).ExpectAsync(HttpStatusCode.Forbidden);
        await outsider.GetAsync(new Uri($"/api/orgs/{orgId}/docs", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await outsider.GetAsync(new Uri($"/api/docs/{doc.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        using var treeResponse = await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs", UriKind.Relative));
        var tree = await treeResponse.ReadAsync<DocTreeDto>();
        Assert.False(tree.CanEdit);
        Assert.Equal(["Planning"], tree.Folders);
        Assert.Equal("Roadmap", Assert.Single(tree.Docs).Title);
        Assert.False((await GetAsync(viewer, doc.Id)).CanEdit);
        Assert.True((await GetAsync(commenter, doc.Id)).CanEdit);
        outsider.Dispose();
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Titles_are_unique_per_folder_ignoring_case()
    {
        var (admin, orgId, commenter, viewer) = await OrgAsync();
        await CreateAsync(commenter, orgId, "Notes");
        await CreateAsync(commenter, orgId, "Notes", "Archive");

        await commenter.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "NOTES" }).ExpectAsync(HttpStatusCode.Conflict);
        await commenter.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "a/b" }).ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Links_backlinks_and_tags_come_from_the_text_and_follow_renames()
    {
        var (admin, orgId, commenter, viewer) = await OrgAsync();
        var hub = await CreateAsync(commenter, orgId, "Hub");
        await WriteAsync(hub.Id, "Links to [[Roadmap]] and [[Ideas/Later]] #planning #q3");

        // Links to docs that don't exist yet resolve when they're created.
        Assert.All((await GetAsync(viewer, hub.Id)).Links, l => Assert.Null(l.DocId));
        var roadmap = await CreateAsync(commenter, orgId, "Roadmap");
        var hubDoc = await GetAsync(viewer, hub.Id);
        Assert.Equal(roadmap.Id, hubDoc.Links.Single(l => l.Text == "Roadmap").DocId);
        Assert.Equal(["planning", "q3"], hubDoc.Tags);
        Assert.Equal("Hub", Assert.Single((await GetAsync(viewer, roadmap.Id)).Backlinks).Title);

        // Renaming tells the client which docs link the old name, so it can rewrite them.
        var current = await GetAsync(commenter, roadmap.Id);
        using (var renamed = await commenter.PatchJsonAsync($"/api/docs/{roadmap.Id}", new { version = current.Version, title = "Plan" }))
        {
            Assert.Equal([hub.Id], (await renamed.ReadAsync<DocChangedDto>()).RelinkDocs);
        }

        await commenter.PatchJsonAsync($"/api/docs/{roadmap.Id}", new { version = current.Version, title = "Again" }).ExpectAsync(HttpStatusCode.Conflict);
        Assert.Null((await GetAsync(viewer, hub.Id)).Links.Single(l => l.Text == "Roadmap").DocId);

        using var tagsResponse = await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs/tags", UriKind.Relative));
        Assert.Contains(new DocTagDto("q3", 1), await tagsResponse.ReadAsync<List<DocTagDto>>());
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Search_finds_words_anywhere_in_the_organisations_docs_only()
    {
        var (admin, orgId, commenter, viewer) = await OrgAsync();
        var doc = await CreateAsync(commenter, orgId, "Interview notes");
        await WriteAsync(doc.Id, "The customer mentioned onboarding friction twice.");
        var (_, otherOrg, otherCommenter, _) = await OrgAsync();
        var other = await CreateAsync(otherCommenter, otherOrg, "Elsewhere");
        await WriteAsync(other.Id, "Onboarding friction elsewhere.");

        using var response = await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs/search?q=onboard fric", UriKind.Relative));
        var hit = Assert.Single(await response.ReadAsync<List<DocSearchDto>>());
        Assert.Equal(doc.Id, hit.Id);
        Assert.Contains("\u0002onboarding\u0003", hit.Snippet, StringComparison.Ordinal);
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
        otherCommenter.Dispose();
    }

    [Fact]
    public async Task Folders_move_with_their_docs_and_only_empty_ones_are_deleted()
    {
        var (admin, orgId, commenter, viewer) = await OrgAsync();
        var doc = await CreateAsync(commenter, orgId, "Q3", "Planning/2026");
        await commenter.PostJsonAsync($"/api/orgs/{orgId}/docs/folders", new { path = "Empty" }).ExpectAsync(HttpStatusCode.Created);

        await commenter.PatchJsonAsync($"/api/orgs/{orgId}/docs/folders", new { from = "Planning", to = "Plans" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal("Plans/2026", (await GetAsync(viewer, doc.Id)).Folder);

        await commenter.DeleteAsync(new Uri($"/api/orgs/{orgId}/docs/folders?path=Plans", UriKind.Relative)).ExpectAsync(HttpStatusCode.Conflict);
        await commenter.DeleteAsync(new Uri($"/api/orgs/{orgId}/docs/folders?path=Empty", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        using var treeResponse = await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs", UriKind.Relative));
        Assert.Equal(["Plans", "Plans/2026"], (await treeResponse.ReadAsync<DocTreeDto>()).Folders);
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task A_folder_with_more_docs_than_a_batch_moves_whole_with_history()
    {
        // The move loads its docs a batch at a time (20); each one must still move, get its history entry, and keep its links.
        var (admin, orgId, commenter, viewer) = await OrgAsync();
        var docs = new List<DocSummaryDto>();
        for (var i = 0; i < 45; i++)
        {
            docs.Add(await CreateAsync(commenter, orgId, $"Spec {i:00}", i % 3 == 0 ? "Big/Deeper" : "Big"));
        }

        var outside = await CreateAsync(commenter, orgId, "Index", "Elsewhere");
        await WriteAsync(outside.Id, "[[Big/Spec 07]]");

        // The doc outside that links one of them is named for the client to rewrite its link.
        using (var moved = await commenter.PatchJsonAsync($"/api/orgs/{orgId}/docs/folders", new { from = "Big", to = "Archive" }))
        {
            var relink = (await moved.ReadAsync<JsonElement>()).GetProperty("relinkDocs").EnumerateArray().Select(e => e.GetGuid());
            Assert.Equal([outside.Id], relink);
        }

        for (var i = 0; i < docs.Count; i++)
        {
            var doc = await GetAsync(viewer, docs[i].Id);
            Assert.Equal(i % 3 == 0 ? "Archive/Deeper" : "Archive", doc.Folder);
            using var history = await viewer.GetAsync(new Uri($"/api/docs/{docs[i].Id}/history", UriKind.Relative));
            Assert.Equal("moved", (await history.ReadAsync<List<DocRevisionDto>>()).First().Action);
        }

        Assert.Equal("Elsewhere", (await GetAsync(viewer, outside.Id)).Folder);
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Deleting_keeps_history_and_unlinks_the_doc()
    {
        var (admin, orgId, commenter, viewer) = await OrgAsync();
        var target = await CreateAsync(commenter, orgId, "Target");
        var source = await CreateAsync(commenter, orgId, "Source");
        await WriteAsync(source.Id, "[[Target]]");

        await commenter.DeleteAsync(new Uri($"/api/docs/{target.Id}?version=1", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        await viewer.GetAsync(new Uri($"/api/docs/{target.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        Assert.Null(Assert.Single((await GetAsync(viewer, source.Id)).Links).DocId);
        using var history = await viewer.GetAsync(new Uri($"/api/docs/{target.Id}/history", UriKind.Relative));
        Assert.Equal(["deleted", "created"], (await history.ReadAsync<List<DocRevisionDto>>()).Select(r => r.Action));

        using var graphResponse = await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs/graph", UriKind.Relative));
        var graph = await graphResponse.ReadAsync<DocGraphDto>();
        Assert.Equal(["Source"], graph.Nodes.Select(n => n.Label));
        Assert.Empty(graph.Edges);
        admin.Dispose();
        commenter.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Commenters_give_a_doc_an_icon_and_colour_shown_in_the_tree_and_graph()
    {
        var (_, orgId, commenter, viewer) = await OrgAsync();
        var doc = await CreateAsync(commenter, orgId, "Launch plan");
        var before = await GetAsync(commenter, doc.Id);

        // Names and colours are tidied: any case in, lowercase stored.
        using (var response = await commenter.PutJsonAsync($"/api/docs/{doc.Id}/appearance", new { icon = " Rocket ", color = "#7C3AED" }))
        {
            var updated = await response.ReadAsync<DocDto>();
            Assert.Equal("rocket", updated.Icon);
            Assert.Equal("#7c3aed", updated.Color);
            Assert.Equal(before.Version, updated.Version); // not a change to the doc: renames don't conflict with it
        }

        var tree = await (await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs", UriKind.Relative))).ReadAsync<DocTreeDto>();
        Assert.Equal(("rocket", "#7c3aed"), tree.Docs.Where(d => d.Id == doc.Id).Select(d => (d.Icon, d.Color)).Single());
        var graph = await (await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs/graph", UriKind.Relative))).ReadAsync<DocGraphDto>();
        Assert.Equal(("rocket", "#7c3aed"), graph.Nodes.Where(n => n.Id == $"d:{doc.Id}").Select(n => (n.Icon, n.Color)).Single());

        // Viewers can't; malformed values are refused; empty values go back to the default.
        await viewer.PutJsonAsync($"/api/docs/{doc.Id}/appearance", new { icon = "star", color = (string?)null }).ExpectAsync(HttpStatusCode.Forbidden);
        await commenter.PutJsonAsync($"/api/docs/{doc.Id}/appearance", new { icon = "<script>", color = (string?)null }).ExpectAsync(HttpStatusCode.BadRequest);
        await commenter.PutJsonAsync($"/api/docs/{doc.Id}/appearance", new { icon = "star", color = "red" }).ExpectAsync(HttpStatusCode.BadRequest);
        using (var response = await commenter.PutJsonAsync($"/api/docs/{doc.Id}/appearance", new { icon = "", color = (string?)null }))
        {
            var cleared = await response.ReadAsync<DocDto>();
            Assert.Null(cleared.Icon);
            Assert.Null(cleared.Color);
        }
    }

    [Fact]
    public async Task Tags_have_an_optional_icon_and_colour_for_the_whole_organisation()
    {
        var (_, orgId, commenter, viewer) = await OrgAsync();
        var doc = await CreateAsync(commenter, orgId, "Launch plan");
        await WriteAsync(doc.Id, "Ship it. #launch #mobile");

        // Any case, with or without the #: stored as the tag.
        using (var response = await commenter.PutJsonAsync($"/api/orgs/{orgId}/docs/tags/%23Launch", new { icon = "rocket", color = "#EA580C" }))
        {
            var style = await response.ReadAsync<DocTagDto>();
            Assert.Equal(new DocTagDto("launch", 1, "rocket", "#ea580c"), style);
        }

        var tree = await (await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs", UriKind.Relative))).ReadAsync<DocTreeDto>();
        Assert.Contains(new DocTagDto("launch", 1, "rocket", "#ea580c"), tree.Tags!);
        Assert.Contains(new DocTagDto("mobile", 1), tree.Tags!); // unstyled: the defaults
        var tags = await (await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs/tags", UriKind.Relative))).ReadAsync<List<DocTagDto>>();
        Assert.Contains(new DocTagDto("launch", 1, "rocket", "#ea580c"), tags);

        // A colour alone is fine; viewers can't; malformed tags are refused; clearing both removes the style.
        await commenter.PutJsonAsync($"/api/orgs/{orgId}/docs/tags/mobile", new { icon = (string?)null, color = "#2563eb" }).ExpectAsync(HttpStatusCode.OK);
        await viewer.PutJsonAsync($"/api/orgs/{orgId}/docs/tags/launch", new { icon = "star", color = (string?)null }).ExpectAsync(HttpStatusCode.Forbidden);
        await commenter.PutJsonAsync($"/api/orgs/{orgId}/docs/tags/1234", new { icon = "star", color = (string?)null }).ExpectAsync(HttpStatusCode.BadRequest);
        await commenter.PutJsonAsync($"/api/orgs/{orgId}/docs/tags/launch", new { icon = "", color = "" }).ExpectAsync(HttpStatusCode.OK);
        tree = await (await viewer.GetAsync(new Uri($"/api/orgs/{orgId}/docs", UriKind.Relative))).ReadAsync<DocTreeDto>();
        Assert.Contains(new DocTagDto("launch", 1), tree.Tags!);
        Assert.Contains(new DocTagDto("mobile", 1, null, "#2563eb"), tree.Tags!);
    }
}
