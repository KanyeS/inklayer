using System.Net;
using System.Text;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Snapshots;

[Collection(ApiTestGroup.Name)]
public sealed class SnapshotCaptureTests(InklayerApiFactory factory)
{
    private async Task<(HttpClient Admin, OrgDto Org, ProjectDto Project)> SetUpAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        return (admin, org, project);
    }

    [Fact]
    public async Task Captures_a_snapshot_and_lists_it()
    {
        var (admin, _, project) = await SetUpAsync();

        var snapshot = await Capture.SnapshotAsync(admin, project.Id, screenshot: Capture.Png);

        Assert.Equal("https://shop.example/products?id=1", snapshot.Url);
        Assert.Equal(1, snapshot.AssetCount);
        Assert.NotNull(snapshot.ViewUrl);
        Assert.StartsWith(InklayerApiFactory.SnapshotOrigin + "/s/" + snapshot.Id + "/", snapshot.ViewUrl!.ToString(), StringComparison.Ordinal);
        using var list = await admin.GetAsync(new Uri($"/api/projects/{project.Id}/snapshots", UriKind.Relative));
        var item = Assert.Single(await list.ReadAsync<List<SnapshotSummaryDto>>());
        Assert.Equal(snapshot.Id, item.Id);
        Assert.True(item.HasScreenshot);
        admin.Dispose();
    }

    [Fact]
    public async Task Blobs_already_uploaded_by_the_organisation_are_not_requested_again()
    {
        var (admin, _, project) = await SetUpAsync();
        var asset = Encoding.UTF8.GetBytes($"asset-{Guid.NewGuid()}");
        await Capture.UploadAsync(admin, project.Id, asset, "image/png");

        using var response = await admin.PostJsonAsync($"/api/projects/{project.Id}/blobs/missing", new { hashes = new[] { Capture.Hash(asset) } });

        Assert.Empty((await response.ReadAsync<MissingDto>()).Missing);
        admin.Dispose();
    }

    [Fact]
    public async Task Other_organisations_cannot_tell_that_a_blob_exists()
    {
        var (admin, _, project) = await SetUpAsync();
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var otherProject = await Scenario.CreateProjectAsync(admin, otherOrg.Id);
        var secret = Encoding.UTF8.GetBytes($"confidential-{Guid.NewGuid()}");
        await Capture.UploadAsync(admin, project.Id, secret, "image/png");

        using var response = await admin.PostJsonAsync($"/api/projects/{otherProject.Id}/blobs/missing", new { hashes = new[] { Capture.Hash(secret) } });

        // Still "missing" for the other organisation, which has to upload the bytes itself to use them.
        Assert.Equal([Capture.Hash(secret)], (await response.ReadAsync<MissingDto>()).Missing);
        admin.Dispose();
    }

    [Fact]
    public async Task Uploads_whose_content_does_not_match_the_hash_are_rejected()
    {
        var (admin, _, project) = await SetUpAsync();
        using var content = new ByteArrayContent(Encoding.UTF8.GetBytes("actual content"));

        using var response = await admin.PutAsync(new Uri($"/api/projects/{project.Id}/blobs/{Capture.Hash(Encoding.UTF8.GetBytes("claimed content"))}", UriKind.Relative), content);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        admin.Dispose();
    }

    [Fact]
    public async Task Oversized_uploads_are_rejected()
    {
        var (admin, _, project) = await SetUpAsync();

        await Capture.UploadAsync(admin, project.Id, new byte[1024 * 1024 + 1], "image/png", HttpStatusCode.RequestEntityTooLarge);
        admin.Dispose();
    }

    [Fact]
    public async Task Snapshots_cannot_reference_blobs_the_organisation_has_not_uploaded()
    {
        var (admin, _, project) = await SetUpAsync();
        var html = Encoding.UTF8.GetBytes("<html><body>x</body></html>");
        await Capture.UploadAsync(admin, project.Id, html, "text/html");

        using var response = await admin.PostJsonAsync($"/api/projects/{project.Id}/snapshots", new
        {
            url = "https://example.com/", viewportWidth = 100, viewportHeight = 100, devicePixelRatio = 1.0,
            documentHash = Capture.Hash(html),
            assets = new[] { new { hash = new string('a', 64), contentType = "image/png" } },
        });

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Contains(new string('a', 64), await response.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        admin.Dispose();
    }

    [Fact]
    public async Task Screenshots_must_really_be_images()
    {
        var (admin, _, project) = await SetUpAsync();
        var fake = Encoding.UTF8.GetBytes("<script>alert(1)</script>");
        var html = Encoding.UTF8.GetBytes("<html><body>x</body></html>");
        await Capture.UploadAsync(admin, project.Id, fake, "image/png");
        await Capture.UploadAsync(admin, project.Id, html, "text/html");

        await admin.PostJsonAsync($"/api/projects/{project.Id}/snapshots", new
        {
            url = "https://example.com/", viewportWidth = 100, viewportHeight = 100, devicePixelRatio = 1.0,
            documentHash = Capture.Hash(html), screenshotHash = Capture.Hash(fake), assets = Array.Empty<object>(),
        }).ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
    }

    [Theory]
    [InlineData("Viewer", HttpStatusCode.Forbidden)]
    [InlineData("Commenter", HttpStatusCode.Forbidden)]
    [InlineData("Editor", HttpStatusCode.OK)]
    public async Task Capturing_requires_the_editor_role(string role, HttpStatusCode expected)
    {
        var (admin, org, project) = await SetUpAsync();
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, role);

        await member.PostJsonAsync($"/api/projects/{project.Id}/blobs/missing", new { hashes = new[] { new string('b', 64) } }).ExpectAsync(expected);
        admin.Dispose();
    }

    [Fact]
    public async Task Outsiders_cannot_see_or_delete_snapshots()
    {
        var (admin, _, project) = await SetUpAsync();
        var snapshot = await Capture.SnapshotAsync(admin, project.Id);
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Owner");

        await outsider.GetAsync(new Uri($"/api/snapshots/{snapshot.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await outsider.DeleteAsync(new Uri($"/api/snapshots/{snapshot.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await outsider.GetAsync(new Uri($"/api/projects/{project.Id}/snapshots", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        admin.Dispose();
    }

    [Fact]
    public async Task Editors_can_delete_their_own_snapshots_but_not_others()
    {
        var (admin, org, project) = await SetUpAsync();
        var (editor, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");
        var mine = await Capture.SnapshotAsync(editor, project.Id);
        var theirs = await Capture.SnapshotAsync(admin, project.Id);

        await editor.DeleteAsync(new Uri($"/api/snapshots/{theirs.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await editor.DeleteAsync(new Uri($"/api/snapshots/{mine.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        await editor.GetAsync(new Uri($"/api/snapshots/{mine.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        admin.Dispose();
    }

    [Fact]
    public async Task Screenshot_is_served_to_project_members_as_an_image()
    {
        var (admin, _, project) = await SetUpAsync();
        var snapshot = await Capture.SnapshotAsync(admin, project.Id, screenshot: Capture.Png);

        using var response = await admin.GetAsync(new Uri(snapshot.ScreenshotUrl!, UriKind.Relative));

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("image/png", response.Content.Headers.ContentType!.MediaType);
        Assert.Equal(Capture.Png, await response.Content.ReadAsByteArrayAsync());
        admin.Dispose();
    }
}
