using System.Net;

namespace Inklayer.Tests.Infrastructure;

/// <summary>Helpers that set up an organisation and its members through the public API.</summary>
public static class Scenario
{
    public static async Task<OrgDto> CreateOrganizationAsync(HttpClient admin, string? name = null, string[]? domains = null, string defaultRole = "Viewer")
    {
        using var response = await admin.PostJsonAsync("/api/orgs", new { name = name ?? $"Org {Guid.NewGuid():N}", allowedDomains = domains ?? [], defaultRole });
        return await response.ReadAsync<OrgDto>(HttpStatusCode.Created);
    }

    /// <summary>Invites a new person with <paramref name="role"/> and signs them in, which accepts the invitation.</summary>
    public static async Task<(HttpClient Client, MeDto Me)> AddMemberAsync(InklayerApiFactory factory, HttpClient inviter, Guid orgId, string role)
    {
        var identity = Identities.Consumer();
        await inviter.PostJsonAsync($"/api/orgs/{orgId}/invitations", new { email = identity.Email, role }).ExpectAsync(HttpStatusCode.Created);
        var client = await factory.SignInAsync(identity);
        using var meResponse = await client.GetAsync(new Uri("/api/me", UriKind.Relative));
        return (client, await meResponse.ReadAsync<MeDto>());
    }

    /// <summary>
    /// Like <see cref="AddMemberAsync"/>, and also gives the member <paramref name="role"/> on every product the organisation has
    /// now, as an upgrade does for existing members. For tests about what someone can do inside a product.
    /// </summary>
    public static async Task<(HttpClient Client, MeDto Me)> AddProjectMemberAsync(InklayerApiFactory factory, HttpClient inviter, Guid orgId, string role)
    {
        var member = await AddMemberAsync(factory, inviter, orgId, role);
        if (role is "Viewer" or "Commenter" or "Editor")
        {
            using var response = await inviter.GetAsync(new Uri($"/api/orgs/{orgId}/projects?includeArchived=true", UriKind.Relative));
            foreach (var project in await response.ReadAsync<List<ProjectDto>>())
            {
                await GrantAsync(inviter, project.Id, member.Me.Id, role);
            }
        }

        return member;
    }

    /// <summary>Gives a person (<c>user</c>) or a team (<c>team</c>) a role on a product.</summary>
    public static Task GrantAsync(HttpClient manager, Guid projectId, Guid principalId, string role, string principalType = "user") =>
        manager.PutJsonAsync($"/api/access/project/{projectId}/{principalType}/{principalId}", new { role }).ExpectAsync(HttpStatusCode.NoContent);

    public static async Task<TeamDto> CreateTeamAsync(HttpClient admin, Guid orgId, string? name = null)
    {
        using var response = await admin.PostJsonAsync($"/api/orgs/{orgId}/teams", new { name = name ?? $"Team {Guid.NewGuid():N}" });
        return await response.ReadAsync<TeamDto>(HttpStatusCode.Created);
    }

    public static async Task<ProjectDto> CreateProjectAsync(HttpClient client, Guid orgId, string? name = null)
    {
        using var response = await client.PostJsonAsync($"/api/orgs/{orgId}/projects", new { name = name ?? $"Project {Guid.NewGuid():N}" });
        return await response.ReadAsync<ProjectDto>(HttpStatusCode.Created);
    }
}
