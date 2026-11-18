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

    public static async Task<ProjectDto> CreateProjectAsync(HttpClient client, Guid orgId, string? name = null)
    {
        using var response = await client.PostJsonAsync($"/api/orgs/{orgId}/projects", new { name = name ?? $"Project {Guid.NewGuid():N}" });
        return await response.ReadAsync<ProjectDto>(HttpStatusCode.Created);
    }
}
