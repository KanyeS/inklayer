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

    private async Task<(HttpClient Admin, OrgDto Org, ProjectDto Project)> SetUpAsync(bool matchQuery = false, bool matchHash = false)
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        if (matchQuery || matchHash)
        {
            using var updated = await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { liveMatchQuery = matchQuery, liveMatchHash = matchHash });
            project = await updated.ReadAsync<ProjectDto>();
        }

        return (admin, org, project);
    }

    private static async Task<AnnotationDto> CreateAsync(HttpClient client, Guid projectId, string url, string body = "Button is misaligned")
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations", new { url, kind = "Pin", body, anchor = Anchor, geometry = Geometry, viewportWidth = 1440 });
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
        var (commenter, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var site = NewSite();

        var created = await CreateAsync(commenter, project.Id, $"{site}/pricing/?utm_source=newsletter#plans");

        Assert.Null(created.SnapshotId);
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
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
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
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Owner");
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
    public async Task A_page_shows_comments_from_every_project_by_each_projects_rules()
    {
        var (admin, org, loose) = await SetUpAsync();
        using var strictResponse = await admin.PostJsonAsync($"/api/orgs/{org.Id}/projects", new { name = "Strict" });
        var strict = await strictResponse.ReadAsync<ProjectDto>(HttpStatusCode.Created);
        await admin.PatchJsonAsync($"/api/projects/{strict.Id}", new { liveMatchQuery = true }).ExpectAsync(HttpStatusCode.OK);
        var site = NewSite();

        await CreateAsync(admin, loose.Id, $"{site}/search?q=shoes", "loose");
        await CreateAsync(admin, strict.Id, $"{site}/search?q=shoes", "strict");

        var pages = await ListAsync(admin, $"{site}/search?q=hats");
        Assert.Equal("loose", Assert.Single(Assert.Single(pages).Annotations).Body);
        pages = await ListAsync(admin, $"{site}/search?q=shoes");
        Assert.Equal(["loose", "strict"], pages.SelectMany(p => p.Annotations).Select(a => a.Body).Order());
        admin.Dispose();
    }

    [Fact]
    public async Task Loosening_query_matching_merges_existing_pages()
    {
        var (admin, _, project) = await SetUpAsync(matchQuery: true);
        var site = NewSite();
        await CreateAsync(admin, project.Id, $"{site}/search?q=shoes", "shoes");
        await CreateAsync(admin, project.Id, $"{site}/search?q=hats", "hats");

        Assert.Equal("shoes", Assert.Single(Assert.Single(await ListAsync(admin, $"{site}/search?q=shoes")).Annotations).Body);

        await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { liveMatchQuery = false }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal(["shoes", "hats"], Assert.Single(await ListAsync(admin, $"{site}/search")).Annotations.Select(a => a.Body));
        admin.Dispose();
    }

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
        var (commenter, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Owner");
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
}
