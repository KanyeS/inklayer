using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

[Collection(ApiTestGroup.Name)]
public sealed class OrganizationAccessTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task Only_instance_administrators_can_create_organisations()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (owner, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Owner");

        await owner.PostJsonAsync("/api/orgs", new { name = "Not allowed" }).ExpectAsync(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Members_cannot_see_other_organisations_or_their_projects()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var orgA = await Scenario.CreateOrganizationAsync(admin);
        var orgB = await Scenario.CreateOrganizationAsync(admin);
        var projectB = await Scenario.CreateProjectAsync(admin, orgB.Id);
        var (memberOfA, _) = await Scenario.AddMemberAsync(factory, admin, orgA.Id, "Owner");

        // 404, not 403: other tenants' resources can't even be shown to exist.
        await memberOfA.GetAsync(new Uri($"/api/orgs/{orgB.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await memberOfA.GetAsync(new Uri($"/api/orgs/{orgB.Id}/members", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await memberOfA.GetAsync(new Uri($"/api/orgs/{orgB.Id}/projects", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await memberOfA.GetAsync(new Uri($"/api/projects/{projectB.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        await memberOfA.PatchJsonAsync($"/api/projects/{projectB.Id}", new { name = "hijacked" }).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Theory]
    [InlineData("Viewer", HttpStatusCode.Forbidden)]
    [InlineData("Commenter", HttpStatusCode.Forbidden)]
    [InlineData("Editor", HttpStatusCode.Forbidden)]
    [InlineData("Admin", HttpStatusCode.Created)]
    public async Task Creating_projects_requires_admin(string role, HttpStatusCode expected)
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, role);

        await member.PostJsonAsync($"/api/orgs/{org.Id}/projects", new { name = "New project" }).ExpectAsync(expected);
    }

    [Fact]
    public async Task Admins_cannot_hand_out_the_owner_role()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (orgAdmin, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Admin");
        var (_, viewer) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        await orgAdmin.PutJsonAsync($"/api/orgs/{org.Id}/members/{viewer.Id}", new { role = "Owner" }).ExpectAsync(HttpStatusCode.Forbidden);
        await orgAdmin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = Identities.UniqueEmail(), role = "Owner" }).ExpectAsync(HttpStatusCode.Forbidden);
        await orgAdmin.PutJsonAsync($"/api/orgs/{org.Id}/members/{viewer.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task The_last_owner_cannot_be_demoted_or_leave()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        using var adminMe = await admin.GetAsync(new Uri("/api/me", UriKind.Relative));
        var adminUser = await adminMe.ReadAsync<MeDto>();

        await admin.PutJsonAsync($"/api/orgs/{org.Id}/members/{adminUser.Id}", new { role = "Admin" }).ExpectAsync(HttpStatusCode.Conflict);
        await admin.DeleteAsync(new Uri($"/api/orgs/{org.Id}/members/{adminUser.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Members_can_leave_and_lose_access()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (member, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        await member.DeleteAsync(new Uri($"/api/orgs/{org.Id}/members/{me.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);

        await member.GetAsync(new Uri($"/api/orgs/{org.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task An_allowed_domain_can_belong_to_only_one_organisation()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var domain = $"shared{Guid.NewGuid():N}.test";
        await Scenario.CreateOrganizationAsync(admin, domains: [domain]);

        await admin.PostJsonAsync("/api/orgs", new { name = "Second", allowedDomains = new[] { domain } }).ExpectAsync(HttpStatusCode.Conflict);
        await admin.PostJsonAsync("/api/orgs", new { name = "Bad", allowedDomains = new[] { "not a domain" } }).ExpectAsync(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Invalid_requests_are_rejected_with_validation_errors()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);

        await admin.PostJsonAsync("/api/orgs", new { name = "" }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = "not-an-email", role = "Viewer" }).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.PostJsonAsync("/api/orgs", new { name = "x", defaultRole = "Owner" }).ExpectAsync(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Changes_are_recorded_in_the_audit_log()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (_, member) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await admin.PutJsonAsync($"/api/orgs/{org.Id}/members/{member.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NoContent);

        using var response = await admin.GetAsync(new Uri($"/api/orgs/{org.Id}/audit", UriKind.Relative));
        var actions = (await response.ReadAsync<List<AuditDto>>()).Select(e => e.Action).ToList();

        Assert.Equal(["member.role_changed", "invitation.accepted", "invitation.created", "org.created"], actions);
    }

    [Fact]
    public async Task Audit_log_is_for_admins_only()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (editor, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Editor");

        await editor.GetAsync(new Uri($"/api/orgs/{org.Id}/audit", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
    }
}
