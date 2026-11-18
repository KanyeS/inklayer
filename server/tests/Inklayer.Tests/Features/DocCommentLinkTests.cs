using System.Net;
using Inklayer.Api.Features.Docs;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record CommentDocLinkDto(string Text, Guid? DocId, string? Title);

public sealed record CommentMentionDto(Guid DocId, string Title);

public sealed record LinkedCommentDto(Guid Id, string Body, int Version, List<CommentDocLinkDto> DocLinks, List<CommentMentionDto> MentionedIn);

public sealed record CommentDetailDto(Guid Id, Guid OrganizationId, string ProjectName, string PageUrl, string Body, List<CommentDocLinkDto> DocLinks, List<CommentMentionDto> MentionedIn);

/// <summary>Page comments and docs link each other: [[Doc]] in a comment, [[comment:id]] in a doc.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class DocCommentLinkTests(InklayerApiFactory factory)
{
    private static readonly object Anchor = new { element = new { path = new[] { "main > h1" }, tag = "h1" } };
    private static readonly object Geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } };

    private async Task<(HttpClient Admin, Guid OrgId, Guid ProjectId, HttpClient Commenter)> SetUpAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (commenter, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        return (admin, org.Id, project.Id, commenter);
    }

    private static async Task<LinkedCommentDto> CommentAsync(HttpClient client, Guid projectId, string body)
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations",
            new { url = $"https://site-{Guid.NewGuid():N}.example/page", kind = "Pin", body, anchor = Anchor, geometry = Geometry, viewportWidth = 1440 });
        return await response.ReadAsync<LinkedCommentDto>(HttpStatusCode.Created);
    }

    private static async Task<DocSummaryDto> DocAsync(HttpClient client, Guid orgId, string title, string folder = "")
    {
        using var response = await client.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title, folder });
        return await response.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
    }

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

    private static async Task<T> GetAsync<T>(HttpClient client, string url)
    {
        using var response = await client.GetAsync(new Uri(url, UriKind.Relative));
        return await response.ReadAsync<T>();
    }

    [Fact]
    public async Task A_comment_links_docs_and_the_doc_lists_the_comment()
    {
        var (admin, orgId, projectId, commenter) = await SetUpAsync();
        var doc = await DocAsync(commenter, orgId, "Checkout spec");

        var comment = await CommentAsync(commenter, projectId, "Doesn't match [[Checkout spec]] or [[Not written yet]]");

        Assert.Equal([doc.Id, null], comment.DocLinks.Select(l => l.DocId));
        var info = await GetAsync<DocDto>(commenter, $"/api/docs/{doc.Id}");
        Assert.Equal(comment.Id, Assert.Single(info.CommentBacklinks).AnnotationId);

        // Editing the body re-reads its links.
        using (var edited = await commenter.PatchJsonAsync($"/api/annotations/{comment.Id}", new { version = comment.Version, body = "No links now" }))
        {
            Assert.Empty((await edited.ReadAsync<LinkedCommentDto>()).DocLinks);
        }

        Assert.Empty((await GetAsync<DocDto>(commenter, $"/api/docs/{doc.Id}")).CommentBacklinks);
        admin.Dispose();
        commenter.Dispose();
    }

    [Fact]
    public async Task A_doc_links_a_comment_and_the_comment_lists_the_doc()
    {
        var (admin, orgId, projectId, commenter) = await SetUpAsync();
        var comment = await CommentAsync(commenter, projectId, "The logo is blurry");
        var doc = await DocAsync(commenter, orgId, "Design debt");
        await WriteAsync(doc.Id, $"- [[comment:{comment.Id}]] needs a fix");

        var detail = await GetAsync<CommentDetailDto>(commenter, $"/api/annotations/{comment.Id}");
        Assert.Equal(orgId, detail.OrganizationId);
        Assert.Equal(new CommentMentionDto(doc.Id, "Design debt"), Assert.Single(detail.MentionedIn));
        Assert.Equal([comment.Id], (await GetAsync<DocDto>(commenter, $"/api/docs/{doc.Id}")).CommentLinks);

        // The graph shows the link too.
        using var graph = await commenter.GetAsync(new Uri($"/api/orgs/{orgId}/docs/graph", UriKind.Relative));
        Assert.Contains((await graph.ReadAsync<DocGraphDto>()).Edges, e => e.Source == $"d:{doc.Id}" && e.Target == $"c:{comment.Id}");
        admin.Dispose();
        commenter.Dispose();
    }

    [Fact]
    public async Task Renaming_or_moving_a_doc_rewrites_comments_that_link_it()
    {
        var (admin, orgId, projectId, commenter) = await SetUpAsync();
        var doc = await DocAsync(commenter, orgId, "Spec", "Product");
        var comment = await CommentAsync(commenter, projectId, "See [[Spec#Errors|the spec]] and [[Product/Spec]]");

        using (var renamed = await commenter.PatchJsonAsync($"/api/docs/{doc.Id}", new { version = 1, title = "Checkout spec" }))
        {
            await renamed.ReadAsync<DocChangedDto>();
        }

        var afterRename = await GetAsync<CommentDetailDto>(commenter, $"/api/annotations/{comment.Id}");
        Assert.Equal("See [[Checkout spec#Errors|the spec]] and [[Product/Checkout spec]]", afterRename.Body);
        Assert.All(afterRename.DocLinks, l => Assert.Equal(doc.Id, l.DocId));

        await commenter.PatchJsonAsync($"/api/orgs/{orgId}/docs/folders", new { from = "Product", to = "Teams/Product" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal("See [[Checkout spec#Errors|the spec]] and [[Teams/Product/Checkout spec]]",
            (await GetAsync<CommentDetailDto>(commenter, $"/api/annotations/{comment.Id}")).Body);
        admin.Dispose();
        commenter.Dispose();
    }
}
