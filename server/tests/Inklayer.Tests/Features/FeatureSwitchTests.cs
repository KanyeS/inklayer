using System.Net;
using System.Net.Http.Json;
using Inklayer.Api.Features.Presence;
using Inklayer.Tests.Infrastructure;
using Inklayer.Tests.Network;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Inklayer.Tests.Features;

public sealed record FeatureSettingDto(string Feature, bool Enabled, string Source, bool Configured);

public sealed record FeaturesDto(bool Docs, bool LiveCursors, bool Mcp);

public sealed record MeWithFeaturesDto(Guid Id, FeaturesDto Features);

/// <summary>
/// Instance administrators turn major features on and off; the server's configuration sets where they start. The
/// switches are instance-wide, so these tests run on their own server, one at a time, and switch everything back on.
/// </summary>
[Collection(NetworkTestGroup.Name)]
public sealed class FeatureSwitchTests(InklayerApiFactory factory)
{
    private static async Task<List<FeatureSettingDto>> SaveAsync(HttpClient admin, object changes)
    {
        using var response = await admin.PutJsonAsync("/api/admin/features", changes);
        return await response.ReadAsync<List<FeatureSettingDto>>();
    }

    private static Task AllOnAsync(HttpClient admin) => SaveAsync(admin, new { docs = true, liveCursors = true, mcp = true, bugContext = true, issueTrackers = true, sharing = true, boards = true });

    [Fact]
    public async Task Turning_docs_off_hides_them_everywhere_until_turned_back_on()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (member, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        try
        {
            var saved = await SaveAsync(admin, new { docs = false });
            Assert.Equal(("Admin", false), (saved.Single(f => f.Feature == "docs").Source, saved.Single(f => f.Feature == "docs").Enabled));

            using (var refused = await member.GetAsync(new Uri($"/api/orgs/{org.Id}/docs", UriKind.Relative)))
            {
                Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
                Assert.Contains("Docs are turned off", await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
            }

            await member.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Nope" }).ExpectAsync(HttpStatusCode.NotFound);
            using (var me = await member.GetAsync(new Uri("/api/me", UriKind.Relative)))
            {
                Assert.Equal(new FeaturesDto(false, true, true), (await me.ReadAsync<MeWithFeaturesDto>()).Features);
            }

            using (var activity = await member.GetAsync(new Uri("/api/activity", UriKind.Relative)))
            {
                Assert.DoesNotContain("docs", (await activity.ReadAsync<ActivityKindsDto>()).Kinds);
            }

            await AllOnAsync(admin);
            await member.GetAsync(new Uri($"/api/orgs/{org.Id}/docs", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
        }
        finally
        {
            await AllOnAsync(admin);
        }

        member.Dispose();
    }

    [Fact]
    public async Task Turning_ai_assistants_off_closes_the_mcp_endpoint_and_registration()
    {
        using var admin = await factory.SignInAsAdminAsync();
        using var anonymous = factory.CreateClient();
        try
        {
            await SaveAsync(admin, new { mcp = false });
            using (var mcp = await anonymous.PostAsJsonAsync("/api/mcp", new { jsonrpc = "2.0", id = 1, method = "ping" }))
            {
                Assert.Equal(HttpStatusCode.NotFound, mcp.StatusCode);
            }

            await anonymous.GetAsync(new Uri("/.well-known/oauth-protected-resource/api/mcp", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
            using (var register = await anonymous.PostAsJsonAsync("/connect/register",
                new Dictionary<string, object?> { ["client_name"] = "x", ["redirect_uris"] = new[] { "http://127.0.0.1:1/cb" } }))
            {
                Assert.Equal(HttpStatusCode.NotFound, register.StatusCode);
            }

            await AllOnAsync(admin);
            using var back = await anonymous.PostAsJsonAsync("/api/mcp", new { jsonrpc = "2.0", id = 1, method = "ping" });
            Assert.Equal(HttpStatusCode.Unauthorized, back.StatusCode);
        }
        finally
        {
            await AllOnAsync(admin);
        }
    }

    [Fact]
    public async Task Turning_live_cursors_off_disconnects_people_but_docs_keep_working()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (member, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        await using var live = await PresenceProbe.ConnectAsync(factory, member);
        try
        {
            await SaveAsync(admin, new { liveCursors = false });
            await live.Closed.WaitAsync(TimeSpan.FromSeconds(5));

            // Tickets are still issued, because the docs hub signs in with them too…
            using (var ticket = await member.PostJsonAsync("/api/presence/ticket", new { }))
            {
                var value = await ticket.ReadAsync<PresenceTicketResponse>();
                // …but the presence hub itself is closed.
                await Assert.ThrowsAnyAsync<Exception>(() => PresenceProbe.ConnectWithTicketAsync(factory, value.Ticket));
            }
        }
        finally
        {
            await AllOnAsync(admin);
        }

        member.Dispose();
    }

    [Fact]
    public async Task Turning_boards_off_refuses_new_boards_and_opening_them_but_docs_keep_working()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (member, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        using var created = await member.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Planning", kind = "board" });
        var board = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        try
        {
            await SaveAsync(admin, new { boards = false });
            using (var refused = await member.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Another", kind = "board" }))
            {
                Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
                Assert.Contains("Boards are turned off", await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
            }

            await member.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Still a doc" }).ExpectAsync(HttpStatusCode.Created);
            await member.GetAsync(new Uri($"/api/boards/{board.Id}/media/x", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
            await using (var live = await DocsProbe.ConnectAsync(factory, member))
            {
                var error = await Assert.ThrowsAsync<Microsoft.AspNetCore.SignalR.HubException>(() => live.OpenAsync(board.Id));
                Assert.Contains("Boards are turned off", error.Message, StringComparison.Ordinal);
            }
        }
        finally
        {
            await SaveAsync(admin, new { boards = true });
        }

        await using (var live = await DocsProbe.ConnectAsync(factory, member))
        {
            await live.OpenAsync(board.Id);
        }

        member.Dispose();
    }

    [Fact]
    public async Task Turning_bug_context_off_refuses_screenshots_and_page_details()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var (_, _, author, _, _, _, commentId) = await Annotations.BugContextTests.SetUpAsync(factory);
        try
        {
            await SaveAsync(admin, new { bugContext = false });
            await author.PutJsonAsync($"/api/annotations/{commentId}/context", Annotations.BugContextTests.Context).ExpectAsync(HttpStatusCode.NotFound);
            await author.GetAsync(new Uri($"/api/annotations/{commentId}/screenshot", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        }
        finally
        {
            await SaveAsync(admin, new { bugContext = true });
        }

        await author.PutJsonAsync($"/api/annotations/{commentId}/context", Annotations.BugContextTests.Context).ExpectAsync(HttpStatusCode.NoContent);
        author.Dispose();
    }

    [Fact]
    public async Task Turning_issue_trackers_off_refuses_them()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        try
        {
            await SaveAsync(admin, new { issueTrackers = false });
            using var refused = await admin.GetAsync(new Uri($"/api/projects/{project.Id}/issue-trackers", UriKind.Relative));
            Assert.Equal(HttpStatusCode.NotFound, refused.StatusCode);
            Assert.Contains("Issue trackers are turned off", await refused.Content.ReadAsStringAsync(), StringComparison.Ordinal);
            await admin.PostJsonAsync($"/api/annotations/{Guid.NewGuid()}/issues", new { connectionId = Guid.NewGuid() }).ExpectAsync(HttpStatusCode.NotFound);
        }
        finally
        {
            await SaveAsync(admin, new { issueTrackers = true });
        }

        await admin.GetAsync(new Uri($"/api/projects/{project.Id}/issue-trackers", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Only_instance_administrators_change_features()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (owner, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Owner");

        await owner.GetAsync(new Uri("/api/admin/features", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await owner.PutJsonAsync("/api/admin/features", new { docs = false }).ExpectAsync(HttpStatusCode.Forbidden);
        using var features = await owner.GetAsync(new Uri("/api/features", UriKind.Relative));
        Assert.Equal(new FeaturesDto(true, true, true), await features.ReadAsync<FeaturesDto>()); // and the newer switches, not listed in this DTO
        owner.Dispose();
    }

    [Fact]
    public async Task Startup_settings_turn_features_off_until_an_administrator_turns_them_on()
    {
        await using var fresh = new InklayerApiFactory();
        await using var configured = fresh.WithWebHostBuilder(b => b.UseSetting("Inklayer:Features:Docs", "false").UseSetting("Inklayer:Features:Mcp", "false"));
        using var admin = await SignInAsAdminAsync(configured);

        using (var response = await admin.GetAsync(new Uri("/api/admin/features", UriKind.Relative)))
        {
            var features = await response.ReadAsync<List<FeatureSettingDto>>();
            Assert.Equal(new FeatureSettingDto("docs", false, "Config", false), features.Single(f => f.Feature == "docs"));
            Assert.Equal(new FeatureSettingDto("liveCursors", true, "Default", true), features.Single(f => f.Feature == "liveCursors"));
        }

        using var anonymous = configured.CreateClient();
        await anonymous.GetAsync(new Uri("/.well-known/oauth-protected-resource/api/mcp", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        var saved = await SaveAsync(admin, new { docs = true });
        Assert.Equal(new FeatureSettingDto("docs", true, "Admin", false), saved.Single(f => f.Feature == "docs"));
        Assert.False(saved.Single(f => f.Feature == "mcp").Enabled); // untouched: still the startup setting
    }

    private sealed record ActivityKindsDto(List<string> Kinds);

    private static async Task<HttpClient> SignInAsAdminAsync(WebApplicationFactory<Program> derived)
    {
        var client = derived.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });
        client.DefaultRequestHeaders.Add(Inklayer.Api.Auth.CsrfHeader.Name, "1");
        using var response = await client.PostAsJsonAsync(InklayerApiFactory.TestLoginPath,
            Identities.Consumer(InklayerApiFactory.BootstrapAdminEmail, subject: "bootstrap-admin-subject"));
        response.EnsureSuccessStatusCode();
        return client;
    }
}
