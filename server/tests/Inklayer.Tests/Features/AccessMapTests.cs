using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

public sealed record AccessMapNodeDto(string Id, string Kind, int Column, string Label, Guid? EntityId, string? Role, string? PreviousRole, string? Change);

public sealed record AccessMapEdgeDto(string From, string To, string? Role, string? Change);

public sealed record AccessMapDto(string SubjectId, List<AccessMapNodeDto> Nodes, List<AccessMapEdgeDto> Edges, int HiddenProducts)
{
    public AccessMapNodeDto Product(Guid id) => Nodes.Single(n => n.Id == $"project:{id}");
}

/// <summary>The access map: what a person or team reaches and how, and previews of changes.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class AccessMapTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task A_persons_map_shows_each_route_and_the_effective_role()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var checkout = await Scenario.CreateProjectAsync(admin, org.Id, "Checkout");
        var search = await Scenario.CreateProjectAsync(admin, org.Id, "Search");
        await Scenario.CreateProjectAsync(admin, org.Id, "Unrelated");
        var support = await Scenario.CreateTeamAsync(admin, org.Id, "Support");
        var (_, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await admin.PutJsonAsync($"/api/teams/{support.Id}/members/{me.Id}", new { }).ExpectAsync(HttpStatusCode.NoContent);
        await Scenario.GrantAsync(admin, checkout.Id, support.Id, "Commenter", "team");
        await Scenario.GrantAsync(admin, search.Id, support.Id, "Viewer", "team");
        await Scenario.GrantAsync(admin, search.Id, me.Id, "Editor");

        var map = await MapAsync(admin, org.Id, "user", me.Id);

        Assert.Equal($"user:{me.Id}", map.SubjectId);
        Assert.Equal(["Checkout", "Search"], map.Nodes.Where(n => n.Kind == "Product").Select(n => n.Label));
        Assert.Equal("Commenter", map.Product(checkout.Id).Role);
        Assert.Equal("Editor", map.Product(search.Id).Role);
        Assert.Contains(map.Edges, e => e.From == $"team:{support.Id}" && e.To == $"project:{search.Id}" && e.Role == "Viewer");
        Assert.Contains(map.Edges, e => e.From == "direct" && e.To == $"project:{search.Id}" && e.Role == "Editor");
        Assert.All(map.Nodes, n => Assert.Null(n.Change));
    }

    [Fact]
    public async Task Previewing_a_grant_marks_what_it_adds_and_raises()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var checkout = await Scenario.CreateProjectAsync(admin, org.Id, "Checkout");
        var search = await Scenario.CreateProjectAsync(admin, org.Id, "Search");
        var (_, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await Scenario.GrantAsync(admin, search.Id, me.Id, "Viewer");

        var added = await MapAsync(admin, org.Id, "user", me.Id, $"?addProjectId={checkout.Id}&addRole=Commenter");
        Assert.Equal(("Commenter", "Added", null), (added.Product(checkout.Id).Role, added.Product(checkout.Id).Change, added.Product(checkout.Id).PreviousRole));
        Assert.Null(added.Product(search.Id).Change);

        var raised = await MapAsync(admin, org.Id, "user", me.Id, $"?addProjectId={search.Id}&addRole=Editor");
        Assert.Equal(("Editor", "Raised", "Viewer"), (raised.Product(search.Id).Role, raised.Product(search.Id).Change, raised.Product(search.Id).PreviousRole));
        Assert.Single(raised.Edges, e => e.To == $"project:{search.Id}");

        // The preview changes nothing.
        var after = await MapAsync(admin, org.Id, "user", me.Id);
        Assert.DoesNotContain(after.Nodes, n => n.Id == $"project:{checkout.Id}");
    }

    [Fact]
    public async Task Previewing_joining_a_team_shows_what_the_team_brings()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var checkout = await Scenario.CreateProjectAsync(admin, org.Id, "Checkout");
        var payments = await Scenario.CreateTeamAsync(admin, org.Id, "Payments");
        await Scenario.GrantAsync(admin, checkout.Id, payments.Id, "Editor", "team");
        var (_, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        var map = await MapAsync(admin, org.Id, "user", me.Id, $"?addTeamId={payments.Id}");

        Assert.Equal("Added", map.Nodes.Single(n => n.Id == $"team:{payments.Id}").Change);
        Assert.Equal(("Editor", "Added"), (map.Product(checkout.Id).Role, map.Product(checkout.Id).Change));
    }

    [Fact]
    public async Task A_teams_map_lists_its_members_and_what_the_team_gives()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var checkout = await Scenario.CreateProjectAsync(admin, org.Id, "Checkout");
        var search = await Scenario.CreateProjectAsync(admin, org.Id, "Search");
        var payments = await Scenario.CreateTeamAsync(admin, org.Id, "Payments");
        var (_, ana) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await admin.PutJsonAsync($"/api/teams/{payments.Id}/members/{ana.Id}", new { }).ExpectAsync(HttpStatusCode.NoContent);
        await Scenario.GrantAsync(admin, checkout.Id, payments.Id, "Editor", "team");

        var map = await MapAsync(admin, org.Id, "team", payments.Id, $"?addProjectId={search.Id}&addRole=Viewer");

        Assert.Contains(map.Nodes, n => n.Kind == "Person" && n.EntityId == ana.Id && n.Column == 0);
        Assert.Contains(map.Edges, e => e.From == $"user:{ana.Id}" && e.To == $"team:{payments.Id}");
        Assert.Equal("Editor", map.Product(checkout.Id).Role);
        Assert.Equal("Added", map.Product(search.Id).Change);
    }

    [Fact]
    public async Task Admins_reach_every_product_through_the_organisation()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var checkout = await Scenario.CreateProjectAsync(admin, org.Id, "Checkout");
        var (_, orgAdmin) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Admin");

        var map = await MapAsync(admin, org.Id, "user", orgAdmin.Id);

        Assert.Contains(map.Edges, e => e.From == "org" && e.To == $"project:{checkout.Id}" && e.Role == "Admin");
    }

    [Fact]
    public async Task Managers_see_maps_only_for_products_they_can_see_and_others_cannot_see_maps()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var mine = await Scenario.CreateProjectAsync(admin, org.Id, "Mine");
        var secret = await Scenario.CreateProjectAsync(admin, org.Id, "Secret");
        var (manager, managerMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (editor, editorMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var (_, colleague) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        await Scenario.GrantAsync(admin, mine.Id, managerMe.Id, "Manager");
        await Scenario.GrantAsync(admin, mine.Id, editorMe.Id, "Editor");
        await Scenario.GrantAsync(admin, mine.Id, colleague.Id, "Viewer");
        await Scenario.GrantAsync(admin, secret.Id, colleague.Id, "Editor");

        var map = await MapAsync(manager, org.Id, "user", colleague.Id);
        Assert.Equal([mine.Id], map.Nodes.Where(n => n.Kind == "Product").Select(n => n.EntityId!.Value));
        Assert.Equal(1, map.HiddenProducts);

        await editor.GetAsync(new Uri($"/api/orgs/{org.Id}/access-map/user/{colleague.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
    }

    [Fact]
    public async Task Previews_must_name_a_product_and_a_grantable_role_in_this_organisation()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var elsewhere = await Scenario.CreateProjectAsync(admin, otherOrg.Id);
        var (_, me) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var url = $"/api/orgs/{org.Id}/access-map/user/{me.Id}";

        await admin.GetAsync(new Uri($"{url}?addProjectId={project.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.GetAsync(new Uri($"{url}?addProjectId={project.Id}&addRole=Admin", UriKind.Relative)).ExpectAsync(HttpStatusCode.BadRequest);
        await admin.GetAsync(new Uri($"{url}?addProjectId={elsewhere.Id}&addRole=Viewer", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
    }

    private static async Task<AccessMapDto> MapAsync(HttpClient client, Guid orgId, string type, Guid id, string query = "")
    {
        using var response = await client.GetAsync(new Uri($"/api/orgs/{orgId}/access-map/{type}/{id}{query}", UriKind.Relative));
        return await response.ReadAsync<AccessMapDto>();
    }
}
