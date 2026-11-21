using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

/// <summary>Access to products: default deny, grants to people and teams, Managers, and "who can see this?".</summary>
[Collection(ApiTestGroup.Name)]
public sealed class ProjectRoleTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task Members_without_a_grant_see_a_products_name_but_not_whats_in_it()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id, "Checkout");
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");

        using (var list = await member.GetAsync(new Uri($"/api/orgs/{org.Id}/projects", UriKind.Relative)))
        {
            var listed = Assert.Single(await list.ReadAsync<List<ProjectDto>>());
            Assert.Equal(("Checkout", null), (listed.Name, listed.MyRole));
        }

        using (var one = await member.GetAsync(new Uri($"/api/projects/{project.Id}", UriKind.Relative)))
        {
            Assert.Null((await one.ReadAsync<ProjectDto>()).MyRole);
        }

        await member.GetAsync(new Uri($"/api/projects/{project.Id}/live/pages", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await member.GetAsync(new Uri($"/api/access/project/{project.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        using var live = await member.GetAsync(new Uri("/api/live/projects", UriKind.Relative));
        Assert.DoesNotContain(project.Id.ToString(), await live.Content.ReadAsStringAsync(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Other_organisations_products_stay_hidden()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, otherOrg.Id);
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");

        await member.GetAsync(new Uri($"/api/projects/{project.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task A_grant_sets_a_members_role_in_that_product_only()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var design = await Scenario.CreateProjectAsync(admin, org.Id, "Design");
        var marketing = await Scenario.CreateProjectAsync(admin, org.Id, "Marketing");
        var (member, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        await Scenario.GrantAsync(admin, design.Id, me.Id, "Editor");
        await Scenario.GrantAsync(admin, marketing.Id, me.Id, "Viewer");

        using var designResponse = await member.GetAsync(new Uri($"/api/projects/{design.Id}", UriKind.Relative));
        Assert.Equal("Editor", (await designResponse.ReadAsync<ProjectDto>()).MyRole);
        using var listResponse = await member.GetAsync(new Uri($"/api/orgs/{org.Id}/projects", UriKind.Relative));
        var list = await listResponse.ReadAsync<List<ProjectDto>>();
        Assert.Equal("Editor", list.Single(p => p.Id == design.Id).MyRole);
        Assert.Equal("Viewer", list.Single(p => p.Id == marketing.Id).MyRole);
    }

    [Fact]
    public async Task Team_grants_apply_to_every_member_and_the_highest_role_wins()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var team = await Scenario.CreateTeamAsync(admin, org.Id, "Support");
        var (member, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        await Scenario.GrantAsync(admin, project.Id, team.Id, "Commenter", "team");
        await member.GetAsync(new Uri($"/api/projects/{project.Id}/live/pages", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        await admin.PutJsonAsync($"/api/teams/{team.Id}/members/{me.Id}", new { }).ExpectAsync(HttpStatusCode.NoContent);
        using (var response = await member.GetAsync(new Uri($"/api/projects/{project.Id}", UriKind.Relative)))
        {
            Assert.Equal("Commenter", (await response.ReadAsync<ProjectDto>()).MyRole);
        }

        await Scenario.GrantAsync(admin, project.Id, me.Id, "Viewer");
        using (var response = await member.GetAsync(new Uri($"/api/projects/{project.Id}", UriKind.Relative)))
        {
            Assert.Equal("Commenter", (await response.ReadAsync<ProjectDto>()).MyRole);
        }

        using var people = await admin.GetAsync(new Uri($"/api/access/project/{project.Id}/people", UriKind.Relative));
        var row = (await people.ReadAsync<List<AccessPersonDto>>()).Single(p => p.UserId == me.Id);
        Assert.Equal("Commenter", row.Role);
        Assert.Equal(["Team: Support (Commenter)", "Given directly (Viewer)"], row.Via);
    }

    [Fact]
    public async Task Removing_someone_from_a_team_removes_the_access_it_gave()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var team = await Scenario.CreateTeamAsync(admin, org.Id);
        var (member, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await Scenario.GrantAsync(admin, project.Id, team.Id, "Viewer", "team");
        await admin.PutJsonAsync($"/api/teams/{team.Id}/members/{me.Id}", new { }).ExpectAsync(HttpStatusCode.NoContent);
        await member.GetAsync(new Uri($"/api/projects/{project.Id}/live/pages", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);

        await admin.DeleteAsync(new Uri($"/api/teams/{team.Id}/members/{me.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        await member.GetAsync(new Uri($"/api/projects/{project.Id}/live/pages", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Managers_can_change_access_to_their_product_but_not_others()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var mine = await Scenario.CreateProjectAsync(admin, org.Id);
        var other = await Scenario.CreateProjectAsync(admin, org.Id);
        var (manager, managerMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (_, colleague) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await Scenario.GrantAsync(admin, mine.Id, managerMe.Id, "Manager");
        await Scenario.GrantAsync(admin, other.Id, managerMe.Id, "Editor");

        await Scenario.GrantAsync(manager, mine.Id, colleague.Id, "Commenter");
        await manager.PutJsonAsync($"/api/access/project/{other.Id}/user/{colleague.Id}", new { role = "Viewer" }).ExpectAsync(HttpStatusCode.Forbidden);

        using var response = await manager.GetAsync(new Uri($"/api/access/project/{mine.Id}", UriKind.Relative));
        var access = await response.ReadAsync<AccessDto>();
        Assert.True(access.CanManage);
        Assert.Contains(access.Grants, g => g.PrincipalId == colleague.Id && g.Role == "Commenter");
    }

    [Fact]
    public async Task Only_item_roles_can_be_granted_and_only_to_this_organisation()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (_, member) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (_, outsider) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Viewer");
        var outsideTeam = await Scenario.CreateTeamAsync(admin, otherOrg.Id);

        await admin.PutJsonAsync($"/api/access/project/{project.Id}/user/{member.Id}", new { role = "Admin" }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PutJsonAsync($"/api/access/project/{project.Id}/user/{outsider.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NotFound);
        await admin.PutJsonAsync($"/api/access/project/{project.Id}/team/{outsideTeam.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task Manager_is_not_an_organisation_role()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (_, member) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        await admin.PutJsonAsync($"/api/orgs/{org.Id}/members/{member.Id}", new { role = "Manager" }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = $"{Guid.NewGuid():N}@example.com", role = "Manager" }).ExpectAsync(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Organisation_admins_see_every_product_without_a_grant()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (orgAdmin, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Admin");

        using var response = await orgAdmin.GetAsync(new Uri($"/api/projects/{project.Id}", UriKind.Relative));
        Assert.Equal("Admin", (await response.ReadAsync<ProjectDto>()).MyRole);
    }

    [Fact]
    public async Task Removing_a_member_from_the_organisation_removes_their_grants_and_teams()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var team = await Scenario.CreateTeamAsync(admin, org.Id);
        var (_, member) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await Scenario.GrantAsync(admin, project.Id, member.Id, "Editor");
        await admin.PutJsonAsync($"/api/teams/{team.Id}/members/{member.Id}", new { }).ExpectAsync(HttpStatusCode.NoContent);

        await admin.DeleteAsync(new Uri($"/api/orgs/{org.Id}/members/{member.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        using var access = await admin.GetAsync(new Uri($"/api/access/project/{project.Id}", UriKind.Relative));
        Assert.DoesNotContain((await access.ReadAsync<AccessDto>()).Grants, g => g.PrincipalId == member.Id);
        using var members = await admin.GetAsync(new Uri($"/api/teams/{team.Id}/members", UriKind.Relative));
        Assert.Empty(await members.ReadAsync<List<TeamMemberDto>>());
    }

    [Fact]
    public async Task Deleting_a_team_removes_its_grants()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var team = await Scenario.CreateTeamAsync(admin, org.Id);
        await Scenario.GrantAsync(admin, project.Id, team.Id, "Editor", "team");

        await admin.DeleteAsync(new Uri($"/api/teams/{team.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        using var access = await admin.GetAsync(new Uri($"/api/access/project/{project.Id}", UriKind.Relative));
        Assert.Empty((await access.ReadAsync<AccessDto>()).Grants);
    }

    [Fact]
    public async Task Only_admins_manage_teams_and_names_are_unique()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (editor, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");
        await Scenario.CreateTeamAsync(admin, org.Id, "Payments");

        await editor.PostJsonAsync($"/api/orgs/{org.Id}/teams", new { name = "Mine" }).ExpectAsync(HttpStatusCode.Forbidden);
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/teams", new { name = "payments" }).ExpectAsync(HttpStatusCode.Conflict);
        using var list = await editor.GetAsync(new Uri($"/api/orgs/{org.Id}/teams", UriKind.Relative));
        Assert.Contains(await list.ReadAsync<List<TeamDto>>(), t => t.Name == "Payments");
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
