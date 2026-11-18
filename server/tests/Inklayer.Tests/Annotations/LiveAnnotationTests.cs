using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Annotations;

[Collection(ApiTestGroup.Name)]
public sealed class LiveAnnotationTests(InklayerApiFactory factory)
{
    private const string Site = "https://app.example.com";
    private static readonly object Anchor = new { element = new { path = new[] { "main > h1" }, tag = "h1" } };
    private static readonly object Geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } };

    private async Task<(HttpClient Admin, OrgDto Org, ProjectDto Project)> SetUpAsync(bool matchQuery = false, bool matchHash = false)
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        using var updated = await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { liveSites = new[] { "App.Example.com/" }, liveMatchQuery = matchQuery, liveMatchHash = matchHash });
        return (admin, org, await updated.ReadAsync<ProjectDto>());
    }

    private static async Task<AnnotationDto> CreateAsync(HttpClient client, Guid projectId, string url, string body = "Button is misaligned")
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations", new { url, kind = "Pin", body, anchor = Anchor, geometry = Geometry, viewportWidth = 1440 });
        return await response.ReadAsync<AnnotationDto>(HttpStatusCode.Created);
    }

    private static async Task<LivePageDto> ListAsync(HttpClient client, Guid projectId, string url)
    {
        using var response = await client.GetAsync(new Uri($"/api/projects/{projectId}/live/annotations?url={Uri.EscapeDataString(url)}", UriKind.Relative));
        return await response.ReadAsync<LivePageDto>();
    }

    [Fact]
    public async Task Admins_set_live_sites_as_normalised_origins()
    {
        var (admin, _, project) = await SetUpAsync();

        Assert.Equal([Site], project.LiveSites);
        await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { liveSites = new[] { "https://app.example.com/some/path" } }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { liveSites = Enumerable.Range(0, 21).Select(i => $"https://s{i}.example.com").ToArray() })
            .ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
    }

    [Fact]
    public async Task Only_project_admins_can_change_live_sites()
    {
        var (admin, org, project) = await SetUpAsync();
        var (editor, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");

        await editor.PatchJsonAsync($"/api/projects/{project.Id}", new { liveSites = new[] { "https://evil.example" } }).ExpectAsync(HttpStatusCode.Forbidden);
        admin.Dispose();
    }

    [Fact]
    public async Task Live_sites_list_only_projects_the_caller_can_view()
    {
        var (admin, org, project) = await SetUpAsync();
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Owner");

        using var mine = await member.GetAsync(new Uri("/api/live/sites", UriKind.Relative));
        var site = Assert.Single(await mine.ReadAsync<List<LiveSiteDto>>(), s => s.ProjectId == project.Id);
        Assert.Equal(Site, site.Origin);
        Assert.Equal("Commenter", site.MyRole);

        using var theirs = await outsider.GetAsync(new Uri("/api/live/sites", UriKind.Relative));
        Assert.DoesNotContain(await theirs.ReadAsync<List<LiveSiteDto>>(), s => s.ProjectId == project.Id);
        admin.Dispose();
    }

    [Fact]
    public async Task Comments_on_a_live_page_show_for_every_version_of_its_url()
    {
        var (admin, org, project) = await SetUpAsync();
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        var created = await CreateAsync(admin, project.Id, $"{Site}/pricing/?utm_source=newsletter#plans");

        Assert.Null(created.SnapshotId);
        Assert.Equal($"{Site}/pricing", created.PageUrl);
        var page = await ListAsync(viewer, project.Id, $"{Site}/pricing?ref=footer");
        Assert.Equal($"{Site}/pricing", page.PageUrl);
        Assert.Equal("Button is misaligned", Assert.Single(page.Annotations).Body);
        Assert.Empty((await ListAsync(viewer, project.Id, $"{Site}/about")).Annotations);
        admin.Dispose();
    }

    [Fact]
    public async Task Query_matching_keeps_pages_apart_and_loosening_it_merges_them()
    {
        var (admin, _, project) = await SetUpAsync(matchQuery: true);
        await CreateAsync(admin, project.Id, $"{Site}/search?q=shoes", "shoes");
        await CreateAsync(admin, project.Id, $"{Site}/search?q=hats", "hats");

        Assert.Equal("shoes", Assert.Single((await ListAsync(admin, project.Id, $"{Site}/search?q=shoes")).Annotations).Body);

        await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { liveMatchQuery = false }).ExpectAsync(HttpStatusCode.OK);
        var merged = await ListAsync(admin, project.Id, $"{Site}/search");
        Assert.Equal(["shoes", "hats"], merged.Annotations.Select(a => a.Body));
        admin.Dispose();
    }

    [Fact]
    public async Task Pages_outside_the_project_sites_are_rejected()
    {
        var (admin, _, project) = await SetUpAsync();

        await admin.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new { url = "https://elsewhere.example/page", kind = "Pin", anchor = Anchor, geometry = Geometry })
            .ExpectAsync(HttpStatusCode.BadRequest);
        await admin.GetAsync(new Uri($"/api/projects/{project.Id}/live/annotations?url={Uri.EscapeDataString("http://app.example.com/")}", UriKind.Relative))
            .ExpectAsync(HttpStatusCode.BadRequest);
        await admin.GetAsync(new Uri($"/api/projects/{project.Id}/live/annotations?url=javascript:alert(1)", UriKind.Relative))
            .ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
    }

    [Fact]
    public async Task Live_annotations_follow_the_usual_permissions_and_history()
    {
        var (admin, org, project) = await SetUpAsync();
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (commenter, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Owner");
        var url = $"{Site}/checkout";

        await viewer.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new { url, kind = "Pin", anchor = Anchor, geometry = Geometry }).ExpectAsync(HttpStatusCode.Forbidden);
        await outsider.GetAsync(new Uri($"/api/projects/{project.Id}/live/annotations?url={Uri.EscapeDataString(url)}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        var annotation = await CreateAsync(commenter, project.Id, url);
        await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        await commenter.DeleteAsync(new Uri($"/api/annotations/{annotation.Id}?version=2", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        Assert.Empty((await ListAsync(admin, project.Id, url)).Annotations);
        using var history = await admin.GetAsync(new Uri($"/api/annotations/{annotation.Id}/history", UriKind.Relative));
        Assert.Equal(["created", "resolved", "deleted"], (await history.ReadAsync<List<RevisionDto>>()).Select(r => r.Action));
        admin.Dispose();
    }

    [Fact]
    public async Task Pages_summary_counts_open_and_resolved_comments()
    {
        var (admin, _, project) = await SetUpAsync();
        var first = await CreateAsync(admin, project.Id, $"{Site}/a");
        await CreateAsync(admin, project.Id, $"{Site}/a");
        await CreateAsync(admin, project.Id, $"{Site}/b");
        await admin.PatchJsonAsync($"/api/annotations/{first.Id}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);

        using var response = await admin.GetAsync(new Uri($"/api/projects/{project.Id}/live/pages", UriKind.Relative));
        var pages = await response.ReadAsync<List<LivePageSummaryDto>>();

        var a = Assert.Single(pages, p => p.PageUrl == $"{Site}/a");
        Assert.Equal((1, 1), (a.OpenCount, a.ResolvedCount));
        Assert.Equal(1, Assert.Single(pages, p => p.PageUrl == $"{Site}/b").OpenCount);
        admin.Dispose();
    }
}
