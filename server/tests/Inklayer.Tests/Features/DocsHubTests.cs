using System.Net;
using System.Threading.Channels;
using Inklayer.Api.Features.Presence;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record DocUpdateDto(long Seq, byte[] Bytes);

public sealed record DocOpenDto(Guid DocId, byte[]? State, string Content, long SnapshotSeq, List<DocUpdateDto> Updates, bool CanEdit, PresencePeerDto Me, List<PresencePeerDto> Peers);

/// <summary>One browser tab on the docs hub, recording what the server sends it.</summary>
public sealed class DocsProbe : IAsyncDisposable
{
    private readonly Channel<(string Kind, string Data)> _events = Channel.CreateUnbounded<(string, string)>();

    private DocsProbe(HubConnection connection)
    {
        Connection = connection;
        connection.On<Guid, long, byte[]>("update", (_, seq, bytes) => Write("update", $"{seq}:{Convert.ToHexString(bytes)}"));
        connection.On<Guid, byte[]>("awareness", (_, bytes) => Write("awareness", Convert.ToHexString(bytes)));
        connection.On<Guid, PresencePeerDto>("peerJoin", (_, peer) => Write("peerJoin", peer.Name));
        connection.On<Guid, string, long>("peerLeave", (_, _, clientId) => Write("peerLeave", clientId.ToString(System.Globalization.CultureInfo.InvariantCulture)));
        connection.On<Guid>("compact", _ => Write("compact", ""));
        connection.On<Guid, string>("closed", (_, reason) => Write("closed", reason));
        connection.On<Guid, bool>("access", (_, canEdit) => Write("access", canEdit.ToString()));
    }

    public HubConnection Connection { get; }

    public static async Task<DocsProbe> ConnectAsync(InklayerApiFactory factory, HttpClient client)
    {
        using var response = await client.PostJsonAsync("/api/presence/ticket", new { });
        var ticket = await response.ReadAsync<PresenceTicketResponse>();
        var connection = new HubConnectionBuilder()
            .WithUrl($"http://localhost/api/docs/hub?access_token={Uri.EscapeDataString(ticket.Ticket)}", o =>
            {
                o.Transports = HttpTransportType.WebSockets;
                o.SkipNegotiation = true;
                o.WebSocketFactory = async (context, ct) => await factory.Server.CreateWebSocketClient().ConnectAsync(context.Uri, ct);
            })
            .Build();
        var probe = new DocsProbe(connection);
        await connection.StartAsync();
        return probe;
    }

    public Task<DocOpenDto> OpenAsync(Guid docId, long clientId = 1) => Connection.InvokeAsync<DocOpenDto>("Open", docId, clientId);

    public Task<long> UpdateAsync(Guid docId, params byte[] bytes) => Connection.InvokeAsync<long>("Update", docId, bytes);

    public Task<bool> SnapshotAsync(Guid docId, byte[] state, string markdown, long upToSeq) =>
        Connection.InvokeAsync<bool>("Snapshot", docId, state, markdown, upToSeq);

    public async Task<(string Kind, string Data)> NextAsync(string? kind = null)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (true)
        {
            var next = await _events.Reader.ReadAsync(timeout.Token);
            if (kind is null || next.Kind == kind)
            {
                return next;
            }
        }
    }

    public ValueTask DisposeAsync() => Connection.DisposeAsync();

    private void Write(string kind, string data) => _events.Writer.TryWrite((kind, data));
}

[Collection(ApiTestGroup.Name)]
public sealed class DocsHubTests(InklayerApiFactory factory)
{
    private async Task<(HttpClient Admin, Guid OrgId, HttpClient Ana, MeDto AnaMe, HttpClient Ben, HttpClient Viewer, MeDto ViewerMe, Guid DocId)> SetUpAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (ana, anaMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (ben, _) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Commenter");
        var (viewer, viewerMe) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");
        using var created = await ana.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = $"Doc {Guid.NewGuid():N}" });
        var doc = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        return (admin, org.Id, ana, anaMe, ben, viewer, viewerMe, doc.Id);
    }

    [Fact]
    public async Task Edits_are_numbered_stored_and_sent_to_everyone_else_on_the_doc()
    {
        var (admin, _, ana, anaMe, ben, viewer, _, docId) = await SetUpAsync();
        await using var anaLive = await DocsProbe.ConnectAsync(factory, ana);
        await using var benLive = await DocsProbe.ConnectAsync(factory, ben);

        var opened = await anaLive.OpenAsync(docId, clientId: 11);
        Assert.True(opened.CanEdit);
        Assert.Null(opened.State);
        Assert.Equal(anaMe.DisplayName, opened.Me.Name);
        Assert.Single((await benLive.OpenAsync(docId, clientId: 22)).Peers);
        Assert.Equal("peerJoin", (await anaLive.NextAsync()).Kind);

        Assert.Equal(1, await anaLive.UpdateAsync(docId, 1, 2, 3));
        Assert.Equal(2, await anaLive.UpdateAsync(docId, 4));
        Assert.Equal("1:010203", (await benLive.NextAsync("update")).Data);
        Assert.Equal("2:04", (await benLive.NextAsync("update")).Data);

        await anaLive.Connection.SendAsync("Awareness", docId, new byte[] { 9 });
        Assert.Equal("09", (await benLive.NextAsync("awareness")).Data);

        // Someone opening now gets every update so far.
        await using var viewerLive = await DocsProbe.ConnectAsync(factory, viewer);
        var late = await viewerLive.OpenAsync(docId);
        Assert.Equal([1L, 2L], late.Updates.Select(u => u.Seq));
        Assert.False(late.CanEdit);

        await benLive.Connection.StopAsync();
        Assert.Equal("22", (await anaLive.NextAsync("peerLeave")).Data);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Snapshots_replace_the_updates_they_include_and_never_go_backwards()
    {
        var (admin, _, ana, _, ben, viewer, _, docId) = await SetUpAsync();
        await using var anaLive = await DocsProbe.ConnectAsync(factory, ana);
        await anaLive.OpenAsync(docId);
        for (var i = 1; i <= 3; i++)
        {
            await anaLive.UpdateAsync(docId, (byte)i);
        }

        Assert.False(await anaLive.SnapshotAsync(docId, [0xAA], "too far", upToSeq: 4)); // update 4 doesn't exist
        Assert.True(await anaLive.SnapshotAsync(docId, [0xAA], "Plan for [[Roadmap]] #launch", upToSeq: 2));
        Assert.False(await anaLive.SnapshotAsync(docId, [0xBB], "older", upToSeq: 1));

        await using var benLive = await DocsProbe.ConnectAsync(factory, ben);
        var opened = await benLive.OpenAsync(docId);
        Assert.Equal([0xAA], opened.State);
        Assert.Equal(2, opened.SnapshotSeq);
        Assert.Equal([3L], opened.Updates.Select(u => u.Seq)); // the one the snapshot didn't include is kept
        Assert.Equal("Plan for [[Roadmap]] #launch", opened.Content);

        // The saved text feeds tags, links and history.
        using var response = await viewer.GetAsync(new Uri($"/api/docs/{docId}", UriKind.Relative));
        var doc = await response.ReadAsync<DocDto>();
        Assert.Equal(["launch"], doc.Tags);
        Assert.Equal("Roadmap", Assert.Single(doc.Links).Text);
        using var history = await viewer.GetAsync(new Uri($"/api/docs/{docId}/history", UriKind.Relative));
        Assert.Equal(["edited", "created"], (await history.ReadAsync<List<DocRevisionDto>>()).Select(r => r.Action));
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Editors_are_asked_to_compact_when_updates_pile_up()
    {
        var (admin, _, ana, _, ben, viewer, _, docId) = await SetUpAsync();
        await using var anaLive = await DocsProbe.ConnectAsync(factory, ana);
        await anaLive.OpenAsync(docId);

        // Stay under the rate limit: the test server is fast.
        for (var i = 0; i < 100; i++)
        {
            await anaLive.UpdateAsync(docId, 1);
            if (i % 30 == 29)
            {
                await Task.Delay(1100);
            }
        }

        Assert.Equal("compact", (await anaLive.NextAsync("compact")).Kind);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }

    [Fact]
    public async Task Viewers_read_but_cannot_edit_and_outsiders_cannot_open()
    {
        var (admin, _, ana, _, ben, viewer, _, docId) = await SetUpAsync();
        var (_, _, outsider, _, _, _, _, _) = await SetUpAsync();
        await using var viewerLive = await DocsProbe.ConnectAsync(factory, viewer);
        await using var outsiderLive = await DocsProbe.ConnectAsync(factory, outsider);

        await viewerLive.OpenAsync(docId);
        await Assert.ThrowsAsync<HubException>(() => viewerLive.UpdateAsync(docId, 1));
        await Assert.ThrowsAsync<HubException>(() => viewerLive.SnapshotAsync(docId, [1], "x", 0));
        await Assert.ThrowsAsync<HubException>(() => outsiderLive.OpenAsync(docId));
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
        outsider.Dispose();
    }

    [Fact]
    public async Task Open_docs_follow_role_changes_when_connections_are_checked()
    {
        var (admin, orgId, ana, anaMe, ben, viewer, viewerMe, docId) = await SetUpAsync();
        await using var anaLive = await DocsProbe.ConnectAsync(factory, ana);
        await using var viewerLive = await DocsProbe.ConnectAsync(factory, viewer);
        await anaLive.OpenAsync(docId);
        await viewerLive.OpenAsync(docId);

        await admin.PutJsonAsync($"/api/orgs/{orgId}/members/{viewerMe.Id}", new { role = "Editor" }).ExpectAsync(HttpStatusCode.NoContent);
        await admin.DeleteAsync(new Uri($"/api/orgs/{orgId}/members/{anaMe.Id}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        await factory.Services.GetRequiredService<PresenceRevalidator>().RevalidateAsync(CancellationToken.None);

        Assert.Equal(("access", "True"), await viewerLive.NextAsync("access"));
        Assert.Equal("closed", (await anaLive.NextAsync("closed")).Kind);
        Assert.Equal(1, await viewerLive.UpdateAsync(docId, 7));
        await Assert.ThrowsAsync<HubException>(() => anaLive.UpdateAsync(docId, 1));
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        viewer.Dispose();
    }
}
