using System.Net;
using Inklayer.Api.Features.Docs;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record DocSummaryDto(Guid Id, string Folder, string Title, List<string> Tags);

public sealed record DocTreeDto(List<string> Folders, List<DocSummaryDto> Docs, bool CanEdit);

public sealed record DocLinkDto(string Text, Guid? DocId, string? Title);

public sealed record DocCommentLinkDto(Guid AnnotationId, string Body);

public sealed record DocDto(
    Guid Id, string Folder, string Title, int Version, bool CanEdit, List<string> Tags, List<DocSummaryDto> Backlinks,
    List<DocCommentLinkDto> CommentBacklinks, List<DocLinkDto> Links, List<Guid> CommentLinks);

public sealed record DocChangedDto(DocDto Doc, List<Guid> RelinkDocs);

public sealed record DocSearchDto(Guid Id, string Title, string Snippet);

public sealed record DocTagDto(string Tag, int Count);

public sealed record DocGraphDto(List<DocGraphNodeDto> Nodes, List<DocGraphEdgeDto> Edges);

public sealed record DocGraphNodeDto(string Id, string Kind, string Label);

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
}
