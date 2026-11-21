using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Annotations;

[Collection(ApiTestGroup.Name)]
public sealed class LiveAnnotationTests(InklayerApiFactory factory)
{
    private static readonly object Anchor = new { element = new { path = new[] { "main > h1" }, tag = "h1" } };
    private static readonly object Geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } };

    /// <summary>A unique site per test, so tests sharing the database don't see each other's comments.</summary>
    private static string NewSite() => $"https://site-{Guid.NewGuid():N}.example";

    private async Task<(HttpClient Admin, OrgDto Org, ProjectDto Project)> SetUpAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        return (admin, org, project);
    }

    private static async Task<AnnotationDto> CreateAsync(
        HttpClient client, Guid projectId, string url, string body = "Button is misaligned", bool includeQuery = false, bool includeHash = false)
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations",
            new { url, kind = "Pin", body, anchor = Anchor, geometry = Geometry, viewportWidth = 1440, includeQuery, includeHash });
        return await response.ReadAsync<AnnotationDto>(HttpStatusCode.Created);
    }

    private static async Task<List<LivePageDto>> ListAsync(HttpClient client, string url)
    {
        using var response = await client.GetAsync(new Uri($"/api/live/annotations?url={Uri.EscapeDataString(url)}", UriKind.Relative));
        return await response.ReadAsync<List<LivePageDto>>();
    }

    private static async Task<List<string>> OriginsAsync(HttpClient client)
    {
        using var response = await client.GetAsync(new Uri("/api/live/origins", UriKind.Relative));
        return await response.ReadAsync<List<string>>();
    }

    [Fact]
    public async Task Commenters_can_annotate_any_site_without_setup()
    {
        var (admin, org, project) = await SetUpAsync();
        var (commenter, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var site = NewSite();

        var created = await CreateAsync(commenter, project.Id, $"{site}/pricing/?utm_source=newsletter#plans");

        Assert.Equal(project.Id, created.ProjectId);
        Assert.Equal($"{site}/pricing", created.PageUrl);
        var page = Assert.Single(await ListAsync(admin, $"{site}/pricing?ref=footer"));
        Assert.Equal(project.Id, page.ProjectId);
        Assert.Equal("Button is misaligned", Assert.Single(page.Annotations).Body);
        Assert.Empty(await ListAsync(admin, $"{site}/about"));
        admin.Dispose();
    }

    [Fact]
    public async Task Viewers_see_live_comments_but_cannot_add_them()
    {
        var (admin, org, project) = await SetUpAsync();
        var (viewer, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Viewer");
        var site = NewSite();
        await CreateAsync(admin, project.Id, $"{site}/");

        await viewer.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new { url = $"{site}/", kind = "Pin", anchor = Anchor, geometry = Geometry })
            .ExpectAsync(HttpStatusCode.Forbidden);
        Assert.Single(Assert.Single(await ListAsync(viewer, $"{site}/")).Annotations);

        using var projects = await viewer.GetAsync(new Uri("/api/live/projects", UriKind.Relative));
        var mine = Assert.Single(await projects.ReadAsync<List<LiveProjectDto>>(), p => p.Id == project.Id);
        Assert.Equal(("Viewer", false), (mine.MyRole, mine.CanComment));
        admin.Dispose();
    }

    [Fact]
    public async Task Origins_list_only_sites_with_comments_the_caller_can_see()
    {
        var (admin, org, project) = await SetUpAsync();
        var (member, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Viewer");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddProjectMemberAsync(factory, admin, otherOrg.Id, "Owner");
        var site = NewSite();
        var deletedSite = NewSite();
        await CreateAsync(admin, project.Id, $"{site}/deep/page?x=1");
        var gone = await CreateAsync(admin, project.Id, $"{deletedSite}/");
        await admin.DeleteAsync(new Uri($"/api/annotations/{gone.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        var origins = await OriginsAsync(member);
        Assert.Contains(site, origins);
        Assert.DoesNotContain(deletedSite, origins);
        Assert.DoesNotContain(site, await OriginsAsync(outsider));
        Assert.Empty(await ListAsync(outsider, $"{site}/deep/page"));
        admin.Dispose();
    }

    [Fact]
    public async Task Commenters_choose_the_whole_page_or_the_exact_address()
    {
        var (admin, org, project) = await SetUpAsync();
        var (commenter, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var site = NewSite();

        var everyVideo = await CreateAsync(commenter, project.Id, $"{site}/watch?v=abc", "player controls");
        var oneVideo = await CreateAsync(commenter, project.Id, $"{site}/watch?v=abc&t=30#comments", "this video", includeQuery: true);

        Assert.Equal($"{site}/watch", everyVideo.PageUrl);
        Assert.Equal($"{site}/watch?t=30&v=abc", oneVideo.PageUrl);
        Assert.Equal(["player controls", "this video"], Bodies(await ListAsync(commenter, $"{site}/watch?t=30&v=abc")));
        Assert.Equal(["player controls"], Bodies(await ListAsync(commenter, $"{site}/watch?v=other")));
        Assert.Equal(["player controls"], Bodies(await ListAsync(commenter, $"{site}/watch")));
        admin.Dispose();
    }

    [Fact]
    public async Task A_page_shows_comments_from_every_project_grouped_by_address()
    {
        var (admin, org, first) = await SetUpAsync();
        var second = await Scenario.CreateProjectAsync(admin, org.Id);
        var site = NewSite();

        await CreateAsync(admin, first.Id, $"{site}/app#/settings", "first, page");
        await CreateAsync(admin, first.Id, $"{site}/app#/settings", "first, route", includeHash: true);
        await CreateAsync(admin, second.Id, $"{site}/app#/settings", "second, route", includeHash: true);

        var pages = await ListAsync(admin, $"{site}/app?tab=1#/settings");
        Assert.Equal(3, pages.Count);
        Assert.Equal(["first, page", "first, route", "second, route"], Bodies(pages));
        Assert.Equal(["first, page"], Bodies(await ListAsync(admin, $"{site}/app#/profile")));
        admin.Dispose();
    }

    private static List<string> Bodies(List<LivePageDto> pages) => pages.SelectMany(p => p.Annotations).Select(a => a.Body).Order(StringComparer.Ordinal).ToList();

    [Fact]
    public async Task Only_web_pages_can_be_annotated()
    {
        var (admin, _, project) = await SetUpAsync();

        foreach (var url in new[] { "javascript:alert(1)", "file:///etc/passwd", "/relative", "chrome://settings" })
        {
            await admin.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new { url, kind = "Pin", anchor = Anchor, geometry = Geometry })
                .ExpectAsync(HttpStatusCode.BadRequest);
        }

        await admin.GetAsync(new Uri("/api/live/annotations?url=javascript:alert(1)", UriKind.Relative)).ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
    }

    [Fact]
    public async Task Live_annotations_follow_the_usual_permissions_and_history()
    {
        var (admin, org, project) = await SetUpAsync();
        var (commenter, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddProjectMemberAsync(factory, admin, otherOrg.Id, "Owner");
        var url = $"{NewSite()}/checkout";

        await outsider.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new { url, kind = "Pin", anchor = Anchor, geometry = Geometry })
            .ExpectAsync(HttpStatusCode.NotFound);

        var annotation = await CreateAsync(commenter, project.Id, url);
        await outsider.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.NotFound);
        await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        await commenter.DeleteAsync(new Uri($"/api/annotations/{annotation.Id}?version=2", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        Assert.Empty(await ListAsync(admin, url));
        using var history = await admin.GetAsync(new Uri($"/api/annotations/{annotation.Id}/history", UriKind.Relative));
        Assert.Equal(["created", "resolved", "deleted"], (await history.ReadAsync<List<RevisionDto>>()).Select(r => r.Action));
        admin.Dispose();
    }

    [Fact]
    public async Task Archived_projects_take_no_new_live_comments()
    {
        var (admin, _, project) = await SetUpAsync();
        await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { isArchived = true }).ExpectAsync(HttpStatusCode.OK);

        await admin.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new { url = $"{NewSite()}/", kind = "Pin", anchor = Anchor, geometry = Geometry })
            .ExpectAsync(HttpStatusCode.Conflict);
        admin.Dispose();
    }

    [Fact]
    public async Task Pages_summary_counts_open_and_resolved_comments()
    {
        var (admin, _, project) = await SetUpAsync();
        var site = NewSite();
        var first = await CreateAsync(admin, project.Id, $"{site}/a");
        await CreateAsync(admin, project.Id, $"{site}/a");
        await CreateAsync(admin, project.Id, $"{site}/b");
        await admin.PatchJsonAsync($"/api/annotations/{first.Id}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);

        using var response = await admin.GetAsync(new Uri($"/api/projects/{project.Id}/live/pages", UriKind.Relative));
        var pages = await response.ReadAsync<List<LivePageSummaryDto>>();

        var a = Assert.Single(pages, p => p.PageUrl == $"{site}/a");
        Assert.Equal((1, 1), (a.OpenCount, a.ResolvedCount));
        Assert.Equal(1, Assert.Single(pages, p => p.PageUrl == $"{site}/b").OpenCount);
        admin.Dispose();
    }

    [Fact]
    public async Task Only_the_author_or_an_admin_can_edit_but_anyone_who_comments_can_resolve()
    {
        var (admin, org, project) = await SetUpAsync();
        var (author, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var (other, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Editor");
        var annotation = await CreateAsync(author, project.Id, $"{NewSite()}/");

        await other.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, body = "hijacked" }).ExpectAsync(HttpStatusCode.Forbidden);
        await other.DeleteAsync(new Uri($"/api/annotations/{annotation.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);

        using var resolved = await other.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, status = "Resolved" });
        Assert.Equal("Resolved", (await resolved.ReadAsync<AnnotationDto>()).Status);

        using var edited = await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 2, body = "Edited by admin" });
        Assert.Equal(3, (await edited.ReadAsync<AnnotationDto>()).Version);
        admin.Dispose();
    }

    [Fact]
    public async Task Stale_versions_are_rejected_with_the_current_state()
    {
        var (admin, _, project) = await SetUpAsync();
        var annotation = await CreateAsync(admin, project.Id, $"{NewSite()}/");
        await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, body = "First edit" }).ExpectAsync(HttpStatusCode.OK);

        using var conflict = await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, body = "Lost update" });

        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Contains("First edit", await conflict.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        await admin.DeleteAsync(new Uri($"/api/annotations/{annotation.Id}?version=1", UriKind.Relative)).ExpectAsync(HttpStatusCode.Conflict);
        admin.Dispose();
    }

    [Fact]
    public async Task Anchor_geometry_and_colour_are_validated()
    {
        var (admin, _, project) = await SetUpAsync();
        var url = $"/api/projects/{project.Id}/live/annotations";
        var page = $"{NewSite()}/";

        await admin.PostJsonAsync(url, new { url = page, kind = "Ink", anchor = "not an object", geometry = Geometry }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync(url, new { url = page, kind = "Ink", anchor = Anchor, geometry = new { points = new string('x', 600_000) } }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync(url, new { url = page, kind = "Pin", anchor = Anchor, geometry = Geometry, color = "red" }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync(url, new { url = page, kind = "Banana", anchor = Anchor, geometry = Geometry }).ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
    }
}
