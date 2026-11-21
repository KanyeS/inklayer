using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

public sealed record AccessRequestDto(Guid Id, Guid ResourceId, Guid UserId, string DisplayName, string Role, string Message, string Status, string? CurrentRole);

public sealed record AccessInboxItemDto(Guid Id, string Kind, Guid? ProjectId, string Preview, string Where);

public sealed record AccessInboxDto(int Unread, List<AccessInboxItemDto> Items);

/// <summary>Asking for access to a product, and its Managers and the organisation's Admins answering.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class AccessRequestTests(InklayerApiFactory factory)
{
    private sealed record Setup(
        HttpClient Admin, OrgDto Org, ProjectDto Project,
        HttpClient Asker, MeDto AskerMe,
        HttpClient Manager, HttpClient TeamManager, HttpClient OrgAdmin, HttpClient Bystander);

    private async Task<Setup> SetupAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id, "Checkout");
        var (asker, askerMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (manager, managerMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (teamManager, teamManagerMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (orgAdmin, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Admin");
        var (bystander, bystanderMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");

        await Scenario.GrantAsync(admin, project.Id, managerMe.Id, "Manager");
        var leads = await Scenario.CreateTeamAsync(admin, org.Id, "Checkout leads");
        await admin.PutJsonAsync($"/api/teams/{leads.Id}/members/{teamManagerMe.Id}", new { }).ExpectAsync(HttpStatusCode.NoContent);
        await Scenario.GrantAsync(admin, project.Id, leads.Id, "Manager", "team");
        await Scenario.GrantAsync(admin, project.Id, bystanderMe.Id, "Editor");

        return new Setup(admin, org, project, asker, askerMe, manager, teamManager, orgAdmin, bystander);
    }

    [Fact]
    public async Task Asking_notifies_the_products_managers_and_the_organisations_admins_only()
    {
        var s = await SetupAsync();

        using (var asked = await s.Asker.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { role = "Commenter", message = "I triage checkout bugs" }))
        {
            var request = await asked.ReadAsync<AccessRequestDto>(HttpStatusCode.Created);
            Assert.Equal(("Commenter", "Pending"), (request.Role, request.Status));
        }

        foreach (var decider in new[] { s.Manager, s.TeamManager, s.OrgAdmin })
        {
            var item = Assert.Single((await InboxAsync(decider)).Items, i => i.Kind == "access_requested");
            Assert.Equal((s.Project.Id, "Checkout"), (item.ProjectId, item.Where));
            Assert.Contains("I triage checkout bugs", item.Preview, StringComparison.Ordinal);
        }

        Assert.DoesNotContain((await InboxAsync(s.Bystander)).Items, i => i.Kind == "access_requested");
        Assert.DoesNotContain((await InboxAsync(s.Asker)).Items, i => i.Kind == "access_requested");

        using var mine = await s.Asker.GetAsync(new Uri($"/api/projects/{s.Project.Id}", UriKind.Relative));
        Assert.True((await mine.ReadAsync<ProjectDto>()).AccessRequested);
    }

    [Fact]
    public async Task Asking_again_while_pending_updates_the_request_without_notifying_again()
    {
        var s = await SetupAsync();
        await s.Asker.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { }).ExpectAsync(HttpStatusCode.Created);

        await s.Asker.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { role = "Editor" }).ExpectAsync(HttpStatusCode.OK);

        Assert.Single((await InboxAsync(s.Manager)).Items, i => i.Kind == "access_requested");
        using var pending = await s.Manager.GetAsync(new Uri($"/api/access/project/{s.Project.Id}/requests", UriKind.Relative));
        Assert.Equal("Editor", Assert.Single(await pending.ReadAsync<List<AccessRequestDto>>()).Role);
    }

    [Fact]
    public async Task Approving_gives_the_role_and_tells_the_person()
    {
        var s = await SetupAsync();
        var request = await AskAsync(s, "Commenter");

        await s.TeamManager.PostJsonAsync($"/api/access/requests/{request.Id}/approve", new { }).ExpectAsync(HttpStatusCode.NoContent);

        using (var project = await s.Asker.GetAsync(new Uri($"/api/projects/{s.Project.Id}", UriKind.Relative)))
        {
            var dto = await project.ReadAsync<ProjectDto>();
            Assert.Equal(("Commenter", false), (dto.MyRole, dto.AccessRequested));
        }

        await s.Asker.GetAsync(new Uri($"/api/projects/{s.Project.Id}/live/pages", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
        Assert.Single((await InboxAsync(s.Asker)).Items, i => i.Kind == "access_granted" && i.ProjectId == s.Project.Id);
        await s.Manager.PostJsonAsync($"/api/access/requests/{request.Id}/approve", new { }).ExpectAsync(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Whoever_approves_can_give_a_different_role()
    {
        var s = await SetupAsync();
        var request = await AskAsync(s, "Editor");

        await s.Manager.PostJsonAsync($"/api/access/requests/{request.Id}/approve", new { role = "Viewer" }).ExpectAsync(HttpStatusCode.NoContent);

        using var project = await s.Asker.GetAsync(new Uri($"/api/projects/{s.Project.Id}", UriKind.Relative));
        Assert.Equal("Viewer", (await project.ReadAsync<ProjectDto>()).MyRole);
    }

    [Fact]
    public async Task Declining_tells_the_person_and_they_can_ask_again()
    {
        var s = await SetupAsync();
        var request = await AskAsync(s, "Viewer");

        await s.OrgAdmin.PostJsonAsync($"/api/access/requests/{request.Id}/decline", new { }).ExpectAsync(HttpStatusCode.NoContent);

        Assert.Single((await InboxAsync(s.Asker)).Items, i => i.Kind == "access_declined");
        await s.Asker.GetAsync(new Uri($"/api/projects/{s.Project.Id}/live/pages", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await s.Asker.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { }).ExpectAsync(HttpStatusCode.Created);
    }

    [Fact]
    public async Task Only_managers_and_admins_see_and_decide_requests()
    {
        var s = await SetupAsync();
        var request = await AskAsync(s, "Viewer");

        await s.Bystander.GetAsync(new Uri($"/api/access/project/{s.Project.Id}/requests", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await s.Bystander.PostJsonAsync($"/api/access/requests/{request.Id}/approve", new { }).ExpectAsync(HttpStatusCode.Forbidden);
        await s.Asker.PostJsonAsync($"/api/access/requests/{request.Id}/approve", new { }).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task People_can_ask_for_more_but_not_for_what_they_have()
    {
        var s = await SetupAsync();

        await s.Bystander.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { role = "Viewer" }).ExpectAsync(HttpStatusCode.Conflict);
        await s.Bystander.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { role = "Manager" }).ExpectAsync(HttpStatusCode.Created);
        await s.Asker.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { role = "Admin" }).ExpectAsync(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task People_withdraw_their_own_requests()
    {
        var s = await SetupAsync();
        var request = await AskAsync(s, "Viewer");

        await s.Bystander.DeleteAsync(new Uri($"/api/access/requests/{request.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await s.Asker.DeleteAsync(new Uri($"/api/access/requests/{request.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        using var pending = await s.Manager.GetAsync(new Uri($"/api/access/project/{s.Project.Id}/requests", UriKind.Relative));
        Assert.Empty(await pending.ReadAsync<List<AccessRequestDto>>());
    }

    [Fact]
    public async Task Nobody_outside_the_organisation_can_ask()
    {
        var s = await SetupAsync();
        var otherOrg = await Scenario.CreateOrganizationAsync(s.Admin);
        var (outsider, _) = await Scenario.AddMemberAsync(factory, s.Admin, otherOrg.Id, "Editor");

        await outsider.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { }).ExpectAsync(HttpStatusCode.NotFound);
    }

    private static async Task<AccessRequestDto> AskAsync(Setup s, string role)
    {
        using var response = await s.Asker.PostJsonAsync($"/api/access/project/{s.Project.Id}/requests", new { role });
        return await response.ReadAsync<AccessRequestDto>(HttpStatusCode.Created);
    }

    private static async Task<AccessInboxDto> InboxAsync(HttpClient client)
    {
        using var response = await client.GetAsync(new Uri("/api/notifications", UriKind.Relative));
        return await response.ReadAsync<AccessInboxDto>();
    }
}
