using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

[Collection(ApiTestGroup.Name)]
public sealed class ProjectRoleTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task A_project_override_changes_a_members_role_in_that_project_only()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var design = await Scenario.CreateProjectAsync(admin, org.Id, "Design");
        var marketing = await Scenario.CreateProjectAsync(admin, org.Id, "Marketing");
        var (viewer, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        await admin.PutJsonAsync($"/api/projects/{design.Id}/members/{me.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NoContent);

        using var designResponse = await viewer.GetAsync(new Uri($"/api/projects/{design.Id}", UriKind.Relative));
        Assert.Equal("Editor", (await designResponse.ReadAsync<ProjectDto>()).MyRole);
        using var marketingResponse = await viewer.GetAsync(new Uri($"/api/projects/{marketing.Id}", UriKind.Relative));
        Assert.Equal("Viewer", (await marketingResponse.ReadAsync<ProjectDto>()).MyRole);

        using var listResponse = await viewer.GetAsync(new Uri($"/api/orgs/{org.Id}/projects", UriKind.Relative));
        var list = await listResponse.ReadAsync<List<ProjectDto>>();
        Assert.Equal("Editor", list.Single(p => p.Id == design.Id).MyRole);
        Assert.Equal("Viewer", list.Single(p => p.Id == marketing.Id).MyRole);
    }

    [Fact]
    public async Task Overrides_do_not_lower_organisation_admins()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (orgAdmin, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Admin");

        await admin.PutJsonAsync($"/api/projects/{project.Id}/members/{me.Id}", new { role = "Viewer" }).ExpectAsync(HttpStatusCode.NoContent);

        using var response = await orgAdmin.GetAsync(new Uri($"/api/projects/{project.Id}", UriKind.Relative));
        Assert.Equal("Admin", (await response.ReadAsync<ProjectDto>()).MyRole);
    }

    [Fact]
    public async Task Project_roles_are_limited_to_viewer_commenter_and_editor_for_org_members()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (_, member) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (_, outsider) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Viewer");

        await admin.PutJsonAsync($"/api/projects/{project.Id}/members/{member.Id}", new { role = "Admin" }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PutJsonAsync($"/api/projects/{project.Id}/members/{outsider.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Removing_a_member_from_the_organisation_removes_their_project_overrides()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (_, member) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await admin.PutJsonAsync($"/api/projects/{project.Id}/members/{member.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NoContent);

        await admin.DeleteAsync(new Uri($"/api/orgs/{org.Id}/members/{member.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        using var response = await admin.GetAsync(new Uri($"/api/projects/{project.Id}/members", UriKind.Relative));
        Assert.DoesNotContain(await response.ReadAsync<List<ProjectMemberDto>>(), m => m.UserId == member.Id);
    }

    [Fact]
    public async Task Archived_projects_are_hidden_unless_requested()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        await admin.PatchJsonAsync($"/api/projects/{project.Id}", new { isArchived = true }).ExpectAsync(HttpStatusCode.OK);

        using var visible = await admin.GetAsync(new Uri($"/api/orgs/{org.Id}/projects", UriKind.Relative));
        Assert.DoesNotContain(await visible.ReadAsync<List<ProjectDto>>(), p => p.Id == project.Id);
        using var all = await admin.GetAsync(new Uri($"/api/orgs/{org.Id}/projects?includeArchived=true", UriKind.Relative));
        Assert.Contains(await all.ReadAsync<List<ProjectDto>>(), p => p.Id == project.Id);
    }
}
