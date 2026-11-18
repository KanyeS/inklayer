using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Annotations;

[Collection(ApiTestGroup.Name)]
public sealed class AnnotationTests(InklayerApiFactory factory)
{
    private static readonly object Anchor = new { element = new { css = "main > h1", xpath = "/html/body/main/h1" } };
    private static readonly object Geometry = new { x = 0.5, y = 0.25 };

    private async Task<(HttpClient Admin, OrgDto Org, SnapshotDto Snapshot)> SetUpAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var snapshot = await Capture.SnapshotAsync(admin, project.Id);
        return (admin, org, snapshot);
    }

    private static async Task<AnnotationDto> CreateAsync(HttpClient client, Guid snapshotId, string kind = "Pin", string body = "Fix the heading")
    {
        using var response = await client.PostJsonAsync($"/api/snapshots/{snapshotId}/annotations", new { kind, body, color = "#3B82F6", anchor = Anchor, geometry = Geometry, viewportWidth = 1280 });
        return await response.ReadAsync<AnnotationDto>(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Commenters_can_annotate_and_everyone_in_the_project_sees_it()
    {
        var (admin, org, snapshot) = await SetUpAsync();
        var (commenter, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        var created = await CreateAsync(commenter, snapshot.Id);

        Assert.Equal(1, created.Version);
        Assert.Equal("#3b82f6", created.Color);
        Assert.Equal("main > h1", created.Anchor.GetProperty("element").GetProperty("css").GetString());
        Assert.True(created.CanEdit);
        using var list = await viewer.GetAsync(new Uri($"/api/snapshots/{snapshot.Id}/annotations", UriKind.Relative));
        var seen = Assert.Single(await list.ReadAsync<List<AnnotationDto>>());
        Assert.Equal("Fix the heading", seen.Body);
        Assert.False(seen.CanEdit);
        admin.Dispose();
    }

    [Fact]
    public async Task Viewers_cannot_annotate()
    {
        var (admin, org, snapshot) = await SetUpAsync();
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        await viewer.PostJsonAsync($"/api/snapshots/{snapshot.Id}/annotations", new { kind = "Pin", anchor = Anchor, geometry = Geometry })
            .ExpectAsync(HttpStatusCode.Forbidden);
        admin.Dispose();
    }

    [Fact]
    public async Task Only_the_author_or_an_admin_can_edit_but_anyone_who_comments_can_resolve()
    {
        var (admin, org, snapshot) = await SetUpAsync();
        var (author, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (other, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");
        var annotation = await CreateAsync(author, snapshot.Id);

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
        var (admin, _, snapshot) = await SetUpAsync();
        var annotation = await CreateAsync(admin, snapshot.Id);
        await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, body = "First edit" }).ExpectAsync(HttpStatusCode.OK);

        using var conflict = await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, body = "Lost update" });

        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Contains("First edit", await conflict.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        await admin.DeleteAsync(new Uri($"/api/annotations/{annotation.Id}?version=1", UriKind.Relative)).ExpectAsync(HttpStatusCode.Conflict);
        admin.Dispose();
    }

    [Fact]
    public async Task Every_change_is_kept_in_history_including_deletion()
    {
        var (admin, _, snapshot) = await SetUpAsync();
        var annotation = await CreateAsync(admin, snapshot.Id, body: "v1");
        await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, body = "v2" }).ExpectAsync(HttpStatusCode.OK);
        await admin.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 2, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        await admin.DeleteAsync(new Uri($"/api/annotations/{annotation.Id}?version=3", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        using var list = await admin.GetAsync(new Uri($"/api/snapshots/{snapshot.Id}/annotations", UriKind.Relative));
        Assert.Empty(await list.ReadAsync<List<AnnotationDto>>());

        using var response = await admin.GetAsync(new Uri($"/api/annotations/{annotation.Id}/history", UriKind.Relative));
        var history = await response.ReadAsync<List<RevisionDto>>();
        Assert.Equal(["created", "updated", "resolved", "deleted"], history.Select(r => r.Action));
        Assert.Equal([1, 2, 3, 4], history.Select(r => r.Version));
        Assert.Equal("v1", history[0].State.GetProperty("body").GetString());
        Assert.Equal("v2", history[1].State.GetProperty("body").GetString());
        Assert.Equal("Resolved", history[2].State.GetProperty("status").GetString());
        admin.Dispose();
    }

    [Fact]
    public async Task Anchor_and_geometry_must_be_bounded_json_objects()
    {
        var (admin, _, snapshot) = await SetUpAsync();
        var url = $"/api/snapshots/{snapshot.Id}/annotations";

        await admin.PostJsonAsync(url, new { kind = "Ink", anchor = "not an object", geometry = Geometry }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync(url, new { kind = "Ink", anchor = Anchor, geometry = new { points = new string('x', 600_000) } }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync(url, new { kind = "Pin", anchor = Anchor, geometry = Geometry, color = "red" }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync(url, new { kind = "Banana", anchor = Anchor, geometry = Geometry }).ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
    }

    [Fact]
    public async Task Outsiders_cannot_read_or_change_annotations()
    {
        var (admin, _, snapshot) = await SetUpAsync();
        var annotation = await CreateAsync(admin, snapshot.Id);
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Owner");

        await outsider.GetAsync(new Uri($"/api/snapshots/{snapshot.Id}/annotations", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await outsider.GetAsync(new Uri($"/api/annotations/{annotation.Id}/history", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await outsider.PatchJsonAsync($"/api/annotations/{annotation.Id}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.NotFound);
        await outsider.PostJsonAsync($"/api/snapshots/{snapshot.Id}/annotations", new { kind = "Pin", anchor = Anchor, geometry = Geometry }).ExpectAsync(HttpStatusCode.NotFound);
        admin.Dispose();
    }
}
