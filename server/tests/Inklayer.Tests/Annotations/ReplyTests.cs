using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Annotations;

public sealed record ReplyDto(Guid Id, string Body, AuthorDto Author, int Version, bool CanEdit, bool CanDelete);

public sealed record ThreadDto(Guid Id, string Body, int Version, List<ReplyDto> Replies, List<ReplyLinkDto> DocLinks);

public sealed record ReplyLinkDto(string Text, Guid? DocId);

public sealed record ThreadPageDto(Guid ProjectId, List<ThreadDto> Annotations);

public sealed record ReplyActivityDto(string Kind, string Action, string? Detail, Guid? AnnotationId);

public sealed record ReplyActivityPageDto(List<ReplyActivityDto> Items);

public sealed record CommentDetailWithRepliesDto(Guid Id, List<ReplyDto> Replies, bool CanReply);

/// <summary>Replies: a thread under each page comment.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class ReplyTests(InklayerApiFactory factory)
{
    private static readonly object Anchor = new { element = new { path = new[] { "main > h1" }, tag = "h1" } };
    private static readonly object Geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } };

    private async Task<(HttpClient Admin, Guid OrgId, Guid ProjectId, HttpClient Ana, HttpClient Ben, HttpClient Viewer, string Url, ThreadDto Comment)> SetUpAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (ana, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (ben, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var url = $"https://site-{Guid.NewGuid():N}.example/page";
        using var created = await ana.PostJsonAsync($"/api/projects/{project.Id}/live/annotations",
            new { url, kind = "Pin", body = "The logo is blurry", anchor = Anchor, geometry = Geometry, viewportWidth = 1440 });
        return (admin, org.Id, project.Id, ana, ben, viewer, url, await created.ReadAsync<ThreadDto>(HttpStatusCode.Created));
    }

    private static async Task<ReplyDto> ReplyAsync(HttpClient client, Guid annotationId, string body)
    {
        using var response = await client.PostJsonAsync($"/api/annotations/{annotationId}/replies", new { body });
        return await response.ReadAsync<ReplyDto>(HttpStatusCode.Created);
    }

    private static async Task<ThreadDto> ThreadAsync(HttpClient client, string url)
    {
        using var response = await client.GetAsync(new Uri($"/api/live/annotations?url={Uri.EscapeDataString(url)}", UriKind.Relative));
        return Assert.Single(Assert.Single(await response.ReadAsync<List<ThreadPageDto>>()).Annotations);
    }

    [Fact]
    public async Task Commenters_reply_and_everyone_sees_the_thread_in_order()
    {
        var (admin, _, _, ana, ben, viewer, url, comment) = await SetUpAsync();

        await ReplyAsync(ben, comment.Id, "Agreed, it's the SVG export");
        await ReplyAsync(ana, comment.Id, "I'll fix it");
        await viewer.PostJsonAsync($"/api/annotations/{comment.Id}/replies", new { body = "Viewers can't" }).ExpectAsync(HttpStatusCode.Forbidden);
        await ben.PostJsonAsync($"/api/annotations/{comment.Id}/replies", new { body = "  " }).ExpectAsync(HttpStatusCode.BadRequest);

        var thread = await ThreadAsync(viewer, url);
        Assert.Equal(["Agreed, it's the SVG export", "I'll fix it"], thread.Replies.Select(r => r.Body));
        Assert.All(thread.Replies, r => Assert.False(r.CanEdit));
        Assert.Equal([true, false], (await ThreadAsync(ben, url)).Replies.Select(r => r.CanEdit)); // only their own
        Assert.All((await ThreadAsync(admin, url)).Replies, r => Assert.True(r.CanDelete)); // admins moderate
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Authors_edit_and_delete_their_replies_with_a_version_check()
    {
        var (admin, _, _, ana, ben, viewer, url, comment) = await SetUpAsync();
        var reply = await ReplyAsync(ben, comment.Id, "Fist draft");

        await ana.PatchJsonAsync($"/api/replies/{reply.Id}", new { version = 1, body = "Not mine" }).ExpectAsync(HttpStatusCode.Forbidden);
        using (var edited = await ben.PatchJsonAsync($"/api/replies/{reply.Id}", new { version = 1, body = "First draft" }))
        {
            Assert.Equal(2, (await edited.ReadAsync<ReplyDto>()).Version);
        }

        await ben.PatchJsonAsync($"/api/replies/{reply.Id}", new { version = 1, body = "Stale" }).ExpectAsync(HttpStatusCode.Conflict);
        await ben.DeleteAsync(new Uri($"/api/replies/{reply.Id}?version=2", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        Assert.Empty((await ThreadAsync(viewer, url)).Replies);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Replies_can_link_docs_and_show_in_the_activity_log_and_comment_page()
    {
        var (admin, orgId, _, ana, ben, viewer, url, comment) = await SetUpAsync();
        using (var created = await ana.PostJsonAsync($"/api/orgs/{orgId}/docs", new { title = "Brand guide" }))
        {
            await created.ReadAsync<Features.DocSummaryDto>(HttpStatusCode.Created);
        }

        await ReplyAsync(ben, comment.Id, "See [[Brand guide]]");

        Assert.NotNull(Assert.Single((await ThreadAsync(viewer, url)).DocLinks).DocId);
        using (var activity = await viewer.GetAsync(new Uri($"/api/activity?kind=comments&site={Uri.EscapeDataString(new Uri(url).GetLeftPart(UriPartial.Authority))}", UriKind.Relative)))
        {
            var replied = Assert.Single((await activity.ReadAsync<ReplyActivityPageDto>()).Items, i => i.Action == "replied");
            Assert.Equal(("See [[Brand guide]]", comment.Id), (replied.Detail, replied.AnnotationId));
        }

        using var detail = await viewer.GetAsync(new Uri($"/api/annotations/{comment.Id}", UriKind.Relative));
        var page = await detail.ReadAsync<CommentDetailWithRepliesDto>();
        Assert.Single(page.Replies);
        Assert.False(page.CanReply);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }
}
