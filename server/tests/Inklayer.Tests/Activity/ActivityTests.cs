using System.Net;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Activity;

[Collection(ApiTestGroup.Name)]
public sealed class ActivityTests(InklayerApiFactory factory)
{
    private static readonly object Anchor = new { element = new { path = new[] { "h1" }, tag = "h1" } };
    private static readonly object Geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } };

    public sealed record ActorDto(Guid Id, string DisplayName, string? Email);

    public sealed record ItemDto(string Id, string Kind, string Action, DateTime OccurredAt, ActorDto? Actor, Guid? ProjectId, string? ProjectName, string? PageUrl, Guid? AnnotationId, string? Detail);

    public sealed record PageDto(List<ItemDto> Items, List<string> Kinds, DateTime? NextBefore);

    private static string NewSite() => $"https://site-{Guid.NewGuid():N}.example";

    private static async Task<AnnotationDto> CommentAsync(HttpClient client, Guid projectId, string url, string body)
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations", new { url, kind = "Pin", body, anchor = Anchor, geometry = Geometry });
        return await response.ReadAsync<AnnotationDto>(HttpStatusCode.Created);
    }

    private static async Task<PageDto> ActivityAsync(HttpClient client, string query = "")
    {
        using var response = await client.GetAsync(new Uri($"/api/activity{query}", UriKind.Relative));
        return await response.ReadAsync<PageDto>();
    }

    [Fact]
    public async Task Viewers_see_comment_activity_in_their_projects_only()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (viewer, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var otherProject = await Scenario.CreateProjectAsync(admin, otherOrg.Id);
        var site = NewSite();
        var mine = await CommentAsync(admin, project.Id, $"{site}/pricing", "Logo is blurry");
        await admin.PatchJsonAsync($"/api/annotations/{mine.Id}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        var hidden = await CommentAsync(admin, otherProject.Id, $"{site}/secret", "Not for you");

        var activity = await ActivityAsync(viewer);

        Assert.Equal(["comments", "docs"], activity.Kinds);
        var events = activity.Items.Where(i => i.AnnotationId == mine.Id).ToList();
        Assert.Equal(["resolved", "created"], events.Select(e => e.Action));
        var created = events[1];
        Assert.Equal(($"{site}/pricing", project.Name, "Logo is blurry"), (created.PageUrl, created.ProjectName, created.Detail));
        Assert.Null(created.Actor!.Email); // viewers see names, not email addresses
        Assert.DoesNotContain(activity.Items, i => i.AnnotationId == hidden.Id);
        Assert.DoesNotContain(activity.Items, i => i.Kind != "comments");

        await viewer.GetAsync(new Uri("/api/activity?kind=signins", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await viewer.GetAsync(new Uri("/api/activity?kind=errors", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        admin.Dispose();
    }

    [Fact]
    public async Task The_site_filter_shows_only_that_sites_comments()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var site = NewSite();
        var here = await CommentAsync(admin, project.Id, $"{site}/a", "here");
        var there = await CommentAsync(admin, project.Id, $"{NewSite()}/a", "there");

        var activity = await ActivityAsync(admin, $"?site={Uri.EscapeDataString(site + "/any/page?x=1")}");

        Assert.Contains(activity.Items, i => i.AnnotationId == here.Id);
        Assert.DoesNotContain(activity.Items, i => i.AnnotationId == there.Id);
        Assert.All(activity.Items, i => Assert.StartsWith(site + "/", i.PageUrl, StringComparison.Ordinal));
        await admin.GetAsync(new Uri("/api/activity?site=not-a-site", UriKind.Relative)).ExpectAsync(HttpStatusCode.BadRequest);
        admin.Dispose();
    }

    [Fact]
    public async Task Organisation_admins_see_their_members_signing_in_but_not_errors()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (orgAdmin, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Admin");
        var (member, memberMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var otherOrg = await Scenario.CreateOrganizationAsync(admin);
        var (_, outsiderMe) = await Scenario.AddMemberAsync(factory, admin, otherOrg.Id, "Owner");

        var activity = await ActivityAsync(orgAdmin, "?kind=signins&limit=200");

        Assert.Equal(["comments", "docs", "signins"], activity.Kinds);
        var signIn = Assert.Single(activity.Items, i => i.Actor?.Id == memberMe.Id);
        Assert.Equal(("signed_in", memberMe.Email), (signIn.Action, signIn.Actor!.Email));
        Assert.DoesNotContain(activity.Items, i => i.Actor?.Id == outsiderMe.Id);
        Assert.DoesNotContain(activity.Items, i => i.Action == "sign_in_refused");
        await orgAdmin.GetAsync(new Uri("/api/activity?kind=errors", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        member.Dispose();
        admin.Dispose();
    }

    [Fact]
    public async Task Instance_admins_see_refused_sign_ins_and_server_errors()
    {
        var admin = await factory.SignInAsAdminAsync();
        var stranger = Identities.Consumer();
        await factory.TrySignInAsync(stranger); // not invited: refused

        // An unhandled exception, as the exception-handling middleware would pass it on.
        var marker = Guid.NewGuid().ToString("N");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var context = new DefaultHttpContext { RequestServices = scope.ServiceProvider };
            context.Request.Method = "POST";
            context.Request.Path = "/api/somewhere";
            context.Request.QueryString = new QueryString("?token=secret");
            foreach (var handler in scope.ServiceProvider.GetServices<IExceptionHandler>())
            {
                Assert.False(await handler.TryHandleAsync(context, new InvalidOperationException($"boom {marker}"), CancellationToken.None));
            }
        }

        var activity = await ActivityAsync(admin, "?limit=200");

        Assert.Equal(["comments", "docs", "signins", "errors"], activity.Kinds);
        var refused = Assert.Single(activity.Items, i => i.Action == "sign_in_refused" && i.Detail!.Contains(stranger.Email, StringComparison.Ordinal));
        Assert.Null(refused.Actor);
        var error = Assert.Single(activity.Items, i => i.Kind == "errors" && i.Detail!.Contains(marker, StringComparison.Ordinal));
        Assert.StartsWith("POST /api/somewhere failed (500): InvalidOperationException: boom", error.Detail, StringComparison.Ordinal);
        Assert.DoesNotContain("secret", error.Detail, StringComparison.Ordinal);
        admin.Dispose();
    }

    [Fact]
    public async Task Pages_of_activity_follow_each_other()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var site = NewSite();
        for (var i = 0; i < 5; i++)
        {
            await CommentAsync(admin, project.Id, $"{site}/p{i}", $"comment {i}");
        }

        var first = await ActivityAsync(admin, $"?site={Uri.EscapeDataString(site)}&limit=3");
        var second = await ActivityAsync(admin, $"?site={Uri.EscapeDataString(site)}&limit=3&before={Uri.EscapeDataString(first.NextBefore!.Value.ToString("O"))}");

        Assert.Equal(3, first.Items.Count);
        Assert.Equal(2, second.Items.Count);
        Assert.Null(second.NextBefore);
        Assert.Equal(5, first.Items.Concat(second.Items).Select(i => i.Id).Distinct().Count());
        admin.Dispose();
    }

    [Fact]
    public async Task Signed_out_callers_get_nothing() =>
        await factory.CreateClient().GetAsync(new Uri("/api/activity", UriKind.Relative)).ExpectAsync(HttpStatusCode.Unauthorized);
}
