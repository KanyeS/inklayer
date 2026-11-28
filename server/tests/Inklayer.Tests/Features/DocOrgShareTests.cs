using System.Net;
using Inklayer.Api.Features.Presence;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Organizations;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record DocOrgDto(Guid Id, string Name);

public sealed record DocOrgShareDto(Guid OrganizationId, string Name, bool CanEdit);

public sealed record SharedDocDto(Guid Id, string Title, DocOrgDto From, bool CanEdit);

public sealed record SharedTreeDto(List<DocSummaryDto> Docs, bool CanEdit, List<SharedDocDto>? Shared);

public sealed record SharedDocInfoDto(
    Guid Id, Guid OrganizationId, string Title, int Version, bool CanEdit, bool CanManage, DocOrgDto? SharedFrom, List<DocOrgShareDto>? SharedWith,
    List<DocSummaryDto> Backlinks, List<DocLinkDto> Links);

[Collection(ApiTestGroup.Name)]
public sealed class DocOrgShareTests(InklayerApiFactory factory)
{
    /// <summary>
    /// Two organisations. Ana is a Commenter in both (she shares between them); Ben is a Commenter and Vic a Viewer only in
    /// the second; Amy is an Admin only in the second. Ana's doc lives in the first.
    /// </summary>
    private async Task<Setup> SetUpAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var home = await Scenario.CreateOrganizationAsync(admin);
        var other = await Scenario.CreateOrganizationAsync(admin);
        var (ana, anaMe) = await Scenario.AddMemberAsync(factory, admin, home.Id, "Commenter");
        await JoinAsync(anaMe.Id, other.Id, Role.Commenter);
        var (ben, _) = await Scenario.AddMemberAsync(factory, admin, other.Id, "Commenter");
        var (vic, _) = await Scenario.AddMemberAsync(factory, admin, other.Id, "Viewer");
        var (amy, _) = await Scenario.AddMemberAsync(factory, admin, other.Id, "Admin");
        using var created = await ana.PostJsonAsync($"/api/orgs/{home.Id}/docs", new { title = $"Plan {Guid.NewGuid():N}" });
        var doc = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        return new Setup(admin, home.Id, other.Id, ana, ben, vic, amy, doc.Id);
    }

    private sealed record Setup(HttpClient Admin, Guid HomeId, Guid OtherId, HttpClient Ana, HttpClient Ben, HttpClient Vic, HttpClient Amy, Guid DocId) : IDisposable
    {
        public void Dispose()
        {
            Admin.Dispose();
            Ana.Dispose();
            Ben.Dispose();
            Vic.Dispose();
            Amy.Dispose();
        }
    }

    /// <summary>Makes an existing user a member of another organisation too.</summary>
    private async Task JoinAsync(Guid userId, Guid orgId, Role role)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        db.OrganizationMembers.Add(new OrganizationMember { OrganizationId = orgId, UserId = userId, Role = role, JoinedAt = DateTime.UtcNow });
        await db.SaveChangesAsync();
    }

    private static Task ShareAsync(HttpClient client, Guid docId, Guid orgId, bool canEdit, HttpStatusCode expected = HttpStatusCode.NoContent) =>
        client.PutJsonAsync($"/api/docs/{docId}/organizations/{orgId}", new { canEdit }).ExpectAsync(expected);

    private static async Task<SharedDocInfoDto> GetAsync(HttpClient client, Guid docId)
    {
        using var response = await client.GetAsync(new Uri($"/api/docs/{docId}", UriKind.Relative));
        return await response.ReadAsync<SharedDocInfoDto>();
    }

    private static async Task<SharedTreeDto> TreeAsync(HttpClient client, Guid orgId)
    {
        using var response = await client.GetAsync(new Uri($"/api/orgs/{orgId}/docs", UriKind.Relative));
        return await response.ReadAsync<SharedTreeDto>();
    }

    [Fact]
    public async Task A_shared_doc_is_one_doc_that_both_organisations_open_and_edit()
    {
        using var s = await SetUpAsync();
        await s.Ben.GetAsync(new Uri($"/api/docs/{s.DocId}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);

        await ShareAsync(s.Ana, s.DocId, s.OtherId, canEdit: true);

        var asBen = await GetAsync(s.Ben, s.DocId);
        Assert.True(asBen.CanEdit);
        Assert.False(asBen.CanManage);
        Assert.Equal(s.HomeId, asBen.SharedFrom!.Id);
        Assert.Null(asBen.SharedWith);
        Assert.False((await GetAsync(s.Vic, s.DocId)).CanEdit); // a Viewer there only reads

        var asAna = await GetAsync(s.Ana, s.DocId);
        Assert.True(asAna.CanManage);
        Assert.Null(asAna.SharedFrom);
        Assert.Equal(s.OtherId, Assert.Single(asAna.SharedWith!).OrganizationId);

        // It's listed in the other organisation's docs, apart from its own.
        var benTree = await TreeAsync(s.Ben, s.OtherId);
        Assert.Empty(benTree.Docs);
        var shared = Assert.Single(benTree.Shared!);
        Assert.Equal((s.DocId, s.HomeId, true), (shared.Id, shared.From.Id, shared.CanEdit));
        Assert.False(Assert.Single((await TreeAsync(s.Vic, s.OtherId)).Shared!).CanEdit);
        Assert.Empty((await TreeAsync(s.Ana, s.HomeId)).Shared!);

        // Edits from either organisation go to the same live doc.
        await using var anaLive = await DocsProbe.ConnectAsync(factory, s.Ana);
        await using var benLive = await DocsProbe.ConnectAsync(factory, s.Ben);
        await anaLive.OpenAsync(s.DocId);
        Assert.True((await benLive.OpenAsync(s.DocId)).CanEdit);
        Assert.Equal(1, await benLive.UpdateAsync(s.DocId, 5));
        Assert.Equal(("update", "1:05"), await anaLive.NextAsync("update"));
        Assert.Equal(2, await anaLive.UpdateAsync(s.DocId, 6));
        Assert.Equal(("update", "2:06"), await benLive.NextAsync("update"));
    }

    [Fact]
    public async Task Only_the_home_organisation_renames_moves_deletes_or_shares_it()
    {
        using var s = await SetUpAsync();
        await ShareAsync(s.Ana, s.DocId, s.OtherId, canEdit: true);
        var version = (await GetAsync(s.Ana, s.DocId)).Version;

        await s.Ben.PatchJsonAsync($"/api/docs/{s.DocId}", new { version, title = "Mine now" }).ExpectAsync(HttpStatusCode.Forbidden);
        await s.Ben.PutJsonAsync($"/api/docs/{s.DocId}/appearance", new { icon = "star" }).ExpectAsync(HttpStatusCode.Forbidden);
        await s.Ben.DeleteAsync(new Uri($"/api/docs/{s.DocId}?version={version}", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await ShareAsync(s.Ben, s.DocId, s.OtherId, canEdit: true, HttpStatusCode.Forbidden);

        // History is readable from either side.
        await s.Ben.GetAsync(new Uri($"/api/docs/{s.DocId}/history", UriKind.Relative)).ExpectAsync(HttpStatusCode.OK);

        // Renamed at home, it's renamed for everyone.
        await s.Ana.PatchJsonAsync($"/api/docs/{s.DocId}", new { version, title = "Renamed" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Equal("Renamed", Assert.Single((await TreeAsync(s.Ben, s.OtherId)).Shared!).Title);
    }

    [Fact]
    public async Task Sharing_needs_Commenter_in_both_organisations()
    {
        using var s = await SetUpAsync();
        var (homeViewer, _) = await Scenario.AddMemberAsync(factory, s.Admin, s.HomeId, "Viewer");
        var (homeOnly, _) = await Scenario.AddMemberAsync(factory, s.Admin, s.HomeId, "Commenter");
        var (viewerThere, viewerThereMe) = await Scenario.AddMemberAsync(factory, s.Admin, s.HomeId, "Commenter");
        await JoinAsync(viewerThereMe.Id, s.OtherId, Role.Viewer);

        await ShareAsync(homeViewer, s.DocId, s.OtherId, canEdit: false, HttpStatusCode.Forbidden);
        await ShareAsync(homeOnly, s.DocId, s.OtherId, canEdit: false, HttpStatusCode.NotFound); // not a member there: not revealed
        await ShareAsync(viewerThere, s.DocId, s.OtherId, canEdit: false, HttpStatusCode.Forbidden);
        await ShareAsync(s.Ana, s.DocId, s.HomeId, canEdit: false, HttpStatusCode.BadRequest);
        await ShareAsync(s.Ben, s.DocId, s.OtherId, canEdit: false, HttpStatusCode.NotFound); // can't see it yet
        homeViewer.Dispose();
        homeOnly.Dispose();
        viewerThere.Dispose();
    }

    [Fact]
    public async Task Read_only_shares_and_stopping_sharing_close_it_for_people_who_have_it_open()
    {
        using var s = await SetUpAsync();
        await ShareAsync(s.Ana, s.DocId, s.OtherId, canEdit: true);
        await using var benLive = await DocsProbe.ConnectAsync(factory, s.Ben);
        await benLive.OpenAsync(s.DocId);
        var revalidator = factory.Services.GetRequiredService<PresenceRevalidator>();

        await ShareAsync(s.Ana, s.DocId, s.OtherId, canEdit: false);
        Assert.False((await GetAsync(s.Ben, s.DocId)).CanEdit);
        await revalidator.RevalidateAsync(CancellationToken.None);
        Assert.Equal(("access", "False"), await benLive.NextAsync("access"));
        await Assert.ThrowsAsync<HubException>(() => benLive.UpdateAsync(s.DocId, 1));

        // Ben can't take it out of his organisation; Amy, an Admin there, can.
        await s.Ben.DeleteAsync(new Uri($"/api/docs/{s.DocId}/organizations/{s.OtherId}", UriKind.Relative)).ExpectAsync(HttpStatusCode.Forbidden);
        await s.Amy.DeleteAsync(new Uri($"/api/docs/{s.DocId}/organizations/{s.OtherId}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        await s.Ben.GetAsync(new Uri($"/api/docs/{s.DocId}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NotFound);
        Assert.Empty((await TreeAsync(s.Ben, s.OtherId)).Shared!);
        await revalidator.RevalidateAsync(CancellationToken.None);
        Assert.Equal("closed", (await benLive.NextAsync("closed")).Kind);
        await Assert.ThrowsAsync<HubException>(() => benLive.OpenAsync(s.DocId));
    }

    [Fact]
    public async Task People_with_it_through_a_share_see_only_the_linked_docs_they_can_open()
    {
        using var s = await SetUpAsync();
        var title = (await GetAsync(s.Ana, s.DocId)).Title;
        using var created = await s.Ana.PostJsonAsync($"/api/orgs/{s.HomeId}/docs", new { title = "Secret" });
        var secret = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        await WriteAsync(secret.Id, $"See [[{title}]]");
        await WriteAsync(s.DocId, "Links to [[Secret]]");
        await ShareAsync(s.Ana, s.DocId, s.OtherId, canEdit: false);

        var asAna = await GetAsync(s.Ana, s.DocId);
        Assert.Equal(secret.Id, Assert.Single(asAna.Backlinks).Id);
        Assert.Equal(secret.Id, Assert.Single(asAna.Links).DocId);

        var asBen = await GetAsync(s.Ben, s.DocId);
        Assert.Empty(asBen.Backlinks);
        var link = Assert.Single(asBen.Links);
        Assert.Null(link.DocId);
        Assert.Null(link.Title);
    }

    /// <summary>Stands in for an editor's snapshot through the docs hub.</summary>
    private async Task WriteAsync(Guid docId, string markdown)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var doc = await Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.SingleAsync(db.Docs, d => d.Id == docId);
        doc.Content = markdown;
        await db.SaveChangesAsync();
        await scope.ServiceProvider.GetRequiredService<Inklayer.Api.Features.Docs.DocIndexer>().IndexDocAsync(doc, CancellationToken.None);
        await db.SaveChangesAsync();
    }
}
