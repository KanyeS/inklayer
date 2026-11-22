using System.Net;
using Inklayer.Api.Features.Docs;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Features;
using Inklayer.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Api;

/// <summary>
/// Pages that ask again on a timer get "304 Not Modified" while nothing they show has changed, without the endpoint
/// running; browsers send the stamp back by themselves.
/// </summary>
[Collection(ApiTestGroup.Name)]
public sealed class ChangeStampTests(InklayerApiFactory factory)
{
    private static async Task<(HttpStatusCode Status, string? Stamp)> GetAsync(HttpClient client, string path, string? stamp = null)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(path, UriKind.Relative));
        if (stamp is not null)
        {
            request.Headers.TryAddWithoutValidation("If-None-Match", stamp);
        }

        using var response = await client.SendAsync(request);
        Assert.True(response.Headers.CacheControl is { Private: true, NoCache: true }, response.Headers.CacheControl?.ToString());
        return (response.StatusCode, response.Headers.ETag?.ToString());
    }

    [Fact]
    public async Task A_page_that_asks_again_is_told_nothing_changed_until_something_does()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var url = $"https://site-{Guid.NewGuid():N}.example/page";
        var path = $"/api/live/annotations?url={Uri.EscapeDataString(url)}";

        var (status, stamp) = await GetAsync(admin, path);
        Assert.Equal(HttpStatusCode.OK, status);
        Assert.NotNull(stamp);
        Assert.Equal((HttpStatusCode.NotModified, stamp), await GetAsync(admin, path, stamp));

        // Someone comments: the next ask gets the comments, with a new stamp.
        using (await admin.PostJsonAsync($"/api/projects/{project.Id}/live/annotations",
            new { url, kind = "Pin", body = "Typo", anchor = new { element = new { path = new[] { "h1" }, tag = "h1" } }, geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } }, viewportWidth = 1200 }))
        {
        }

        var (after, newStamp) = await GetAsync(admin, path, stamp);
        Assert.Equal(HttpStatusCode.OK, after);
        Assert.NotEqual(stamp, newStamp);
    }

    [Fact]
    public async Task Saving_live_edits_alone_does_not_change_the_doc_list()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        using var created = await admin.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = $"Doc {Guid.NewGuid():N}" });
        var doc = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        var tree = $"/api/orgs/{org.Id}/docs";
        var (_, stamp) = await GetAsync(admin, tree);

        var edits = factory.Services.GetRequiredService<DocEditBuffer>();
        using (var me = await admin.GetAsync(new Uri("/api/me", UriKind.Relative)))
        {
            await edits.AppendAsync(doc.Id, (await me.ReadAsync<MeDto>()).Id, [1, 2, 3], default);
        }

        await edits.FlushAsync(default);
        Assert.Equal(HttpStatusCode.NotModified, (await GetAsync(admin, tree, stamp)).Status);

        using (await admin.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = $"Doc {Guid.NewGuid():N}" }))
        {
        }

        Assert.Equal(HttpStatusCode.OK, (await GetAsync(admin, tree, stamp)).Status);
    }

    [Theory]
    [InlineData("""INSERT INTO "Annotations" ("Id", "Body") VALUES (@p0, @p1) RETURNING "Version";""", ChangeAreas.Comments)]
    [InlineData("""UPDATE "Docs" AS "d" SET "LastSeq" = @p WHERE "d"."Id" = @docId AND "d"."DeletedAt" IS NULL""", ChangeAreas.None)]
    [InlineData("""UPDATE "Docs" SET "Content" = @p0, "UpdatedAt" = @p1 WHERE "Id" = @p2 RETURNING 1;""", ChangeAreas.Docs | ChangeAreas.Comments)]
    [InlineData("""INSERT INTO "DocUpdates" ("DocId", "Seq") VALUES (@p0, @p1);""", ChangeAreas.None)]
    [InlineData("""DELETE FROM "OrganizationMembers" AS "o" WHERE "o"."Id" = @id""", ChangeAreas.All)]
    [InlineData("""SELECT "a"."Id" FROM "Annotations" AS "a" WHERE "a"."ProjectId" = @p""", ChangeAreas.None)]
    [InlineData("""INSERT INTO "Notifications" ("Id") VALUES (@p0); INSERT INTO "OutboundMessages" ("Id") VALUES (@p1);""", ChangeAreas.Notifications)]
    public void Writes_count_for_the_areas_their_tables_belong_to(string sql, ChangeAreas expected) =>
        Assert.Equal(expected, ChangeClock.AreasOf(sql));
}
