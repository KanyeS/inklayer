using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Inklayer.Api.Features.Presence;
using Inklayer.Tests.Infrastructure;
using Inklayer.Tests.Network;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record PresencePeerDto(string Id, Guid UserId, string Name, string Color);

/// <summary>One person's presence connection, recording what the server sends it.</summary>
public sealed class PresenceProbe : IAsyncDisposable
{
    private readonly Channel<(string Kind, string Page, string Data)> _events = Channel.CreateUnbounded<(string, string, string)>();
    private readonly TaskCompletionSource _closed = new(TaskCreationOptions.RunContinuationsAsynchronously);

    private PresenceProbe(HubConnection connection)
    {
        Connection = connection;
        connection.On<string, PresencePeerDto>("peerJoin", (page, peer) => Write("peerJoin", page, peer.Name));
        connection.On<string, string>("peerLeave", (page, id) => Write("peerLeave", page, id));
        connection.On<string, string, JsonElement>("cursor", (page, id, position) => Write("cursor", page, $"{id} {position.GetRawText()}"));
        connection.On<string, string, JsonElement?>("select", (page, id, anchor) => Write("select", page, $"{id} {anchor?.GetRawText() ?? "null"}"));
        connection.Closed += _ =>
        {
            _closed.TrySetResult();
            return Task.CompletedTask;
        };
    }

    public HubConnection Connection { get; }

    public Task Closed => _closed.Task;

    public static async Task<PresenceProbe> ConnectAsync(InklayerApiFactory factory, HttpClient client, string? clientIp = null)
    {
        using var response = await client.PostJsonAsync("/api/presence/ticket", new { });
        var ticket = await response.ReadAsync<PresenceTicketResponse>();
        return await ConnectWithTicketAsync(factory, ticket.Ticket, clientIp);
    }

    public static async Task<PresenceProbe> ConnectWithTicketAsync(InklayerApiFactory factory, string? ticket, string? clientIp = null)
    {
        var connection = new HubConnectionBuilder()
            .WithUrl($"http://localhost/api/presence/hub?access_token={Uri.EscapeDataString(ticket ?? "")}", o =>
            {
                o.Transports = HttpTransportType.WebSockets;
                o.SkipNegotiation = true;
                o.WebSocketFactory = async (context, ct) =>
                {
                    var client = factory.Server.CreateWebSocketClient();
                    if (clientIp is not null)
                    {
                        client.ConfigureRequest = r => r.Headers[InklayerApiFactory.ClientIpHeader] = clientIp;
                    }

                    return await client.ConnectAsync(context.Uri, ct);
                };
            })
            .Build();
        var probe = new PresenceProbe(connection);
        await connection.StartAsync();
        return probe;
    }

    public Task<List<PresencePeerDto>> JoinAsync(string page) => Connection.InvokeAsync<List<PresencePeerDto>>("Join", page);

    public async Task<(string Kind, string Page, string Data)> NextAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        return await _events.Reader.ReadAsync(timeout.Token);
    }

    /// <summary>Nothing more arrives within a short wait.</summary>
    public async Task ExpectQuietAsync()
    {
        await Task.Delay(300);
        Assert.False(_events.Reader.TryRead(out var unexpected), $"Unexpected {unexpected}");
    }

    public ValueTask DisposeAsync() => Connection.DisposeAsync();

    private void Write(string kind, string page, string data) => _events.Writer.TryWrite((kind, page, data));
}

[Collection(ApiTestGroup.Name)]
public sealed class PresenceTests(InklayerApiFactory factory)
{
    /// <summary>A page id as the extension sends it: the hex SHA-256 of the page's key.</summary>
    private static string NewPage() => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes($"https://example.test/{Guid.NewGuid()}")));

    private async Task<(HttpClient Client, MeDto Me)> MemberOfNewOrgAsync(HttpClient admin, Guid? orgId = null)
    {
        if (orgId is null)
        {
            orgId = (await Scenario.CreateOrganizationAsync(admin)).Id;
            await Scenario.CreateProjectAsync(admin, orgId.Value);
        }

        return await Scenario.AddProjectMemberAsync(factory, admin, orgId.Value, "Viewer");
    }

    [Fact]
    public async Task People_in_the_same_organisation_on_the_same_page_see_each_other()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        await Scenario.CreateProjectAsync(admin, org.Id);
        var (ana, _) = await MemberOfNewOrgAsync(admin, org.Id);
        var (ben, benMe) = await MemberOfNewOrgAsync(admin, org.Id);
        var (outsider, _) = await MemberOfNewOrgAsync(admin);
        var page = NewPage();

        await using var anaLive = await PresenceProbe.ConnectAsync(factory, ana);
        await using var benLive = await PresenceProbe.ConnectAsync(factory, ben);
        await using var outsiderLive = await PresenceProbe.ConnectAsync(factory, outsider);

        Assert.Empty(await anaLive.JoinAsync(page));
        var seenByBen = Assert.Single(await benLive.JoinAsync(page));
        Assert.Matches("^#[0-9A-F]{6}$", seenByBen.Color);
        Assert.Equal(("peerJoin", page, benMe.DisplayName), await anaLive.NextAsync());

        await benLive.Connection.SendAsync("Cursor", page, new { a = new[] { "main", "p:nth-of-type(2)" }, fx = 0.25, fy = 0.5 });
        var cursor = await anaLive.NextAsync();
        Assert.Equal("cursor", cursor.Kind);
        Assert.Contains("\"fx\":0.25", cursor.Data, StringComparison.Ordinal);

        await benLive.Connection.SendAsync("Select", page, (object?)null);
        Assert.EndsWith(" null", (await anaLive.NextAsync()).Data, StringComparison.Ordinal);

        // Someone from another organisation on the same page sees no one and is seen by no one.
        Assert.Empty(await outsiderLive.JoinAsync(page));
        await outsiderLive.Connection.SendAsync("Cursor", page, new { fx = 0.1, fy = 0.1 });
        await anaLive.ExpectQuietAsync();

        await benLive.Connection.StopAsync();
        Assert.Equal("peerLeave", (await anaLive.NextAsync()).Kind);
        admin.Dispose();
        ana.Dispose();
        ben.Dispose();
        outsider.Dispose();
    }

    [Fact]
    public async Task Different_pages_are_separate()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        await Scenario.CreateProjectAsync(admin, org.Id);
        var (ana, _) = await MemberOfNewOrgAsync(admin, org.Id);
        var (ben, _) = await MemberOfNewOrgAsync(admin, org.Id);

        await using var anaLive = await PresenceProbe.ConnectAsync(factory, ana);
        await using var benLive = await PresenceProbe.ConnectAsync(factory, ben);
        await anaLive.JoinAsync(NewPage());
        Assert.Empty(await benLive.JoinAsync(NewPage()));
        await anaLive.ExpectQuietAsync();
        ana.Dispose();
        ben.Dispose();
    }

    [Fact]
    public async Task Tickets_are_single_use_and_required()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var (member, _) = await MemberOfNewOrgAsync(admin);
        using var response = await member.PostJsonAsync("/api/presence/ticket", new { });
        var ticket = await response.ReadAsync<PresenceTicketResponse>();

        await using (await PresenceProbe.ConnectWithTicketAsync(factory, ticket.Ticket))
        {
        }

        await Assert.ThrowsAnyAsync<Exception>(() => PresenceProbe.ConnectWithTicketAsync(factory, ticket.Ticket));
        await Assert.ThrowsAnyAsync<Exception>(() => PresenceProbe.ConnectWithTicketAsync(factory, null));

        using var anonymous = factory.CreateBrowserClient();
        await anonymous.PostJsonAsync("/api/presence/ticket", new { }).ExpectAsync(HttpStatusCode.Unauthorized);
        member.Dispose();
    }

    [Fact]
    public async Task Pages_must_be_hashes()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var (member, _) = await MemberOfNewOrgAsync(admin);
        await using var live = await PresenceProbe.ConnectAsync(factory, member);

        await Assert.ThrowsAsync<HubException>(() => live.JoinAsync("https://example.test/secret-page"));
        member.Dispose();
    }

    [Fact]
    public async Task Disabled_users_are_disconnected_when_connections_are_checked()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var (member, me) = await MemberOfNewOrgAsync(admin);
        await using var live = await PresenceProbe.ConnectAsync(factory, member);
        await live.JoinAsync(NewPage());

        await admin.PostJsonAsync($"/api/admin/users/{me.Id}/disable", new { }).ExpectAsync(HttpStatusCode.NoContent);
        await factory.Services.GetRequiredService<PresenceRevalidator>().RevalidateAsync(CancellationToken.None);

        await live.Closed.WaitAsync(TimeSpan.FromSeconds(5));
        member.Dispose();
    }
}

[Collection(NetworkTestGroup.Name)]
public sealed class PresenceNetworkTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task Connections_from_outside_a_newly_saved_network_list_are_closed()
    {
        using var admin = await factory.SignInAsAdminAsync();
        admin.DefaultRequestHeaders.Add(InklayerApiFactory.ClientIpHeader, "10.8.0.5");
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (member, _) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Viewer");

        await using var fromVpn = await PresenceProbe.ConnectAsync(factory, member, "10.8.3.4");
        await using var fromHome = await PresenceProbe.ConnectAsync(factory, member, "198.51.100.7");
        try
        {
            await admin.PutJsonAsync("/api/admin/network", new { allowedNetworks = new[] { "10.8.0.0/16" } }).ExpectAsync(HttpStatusCode.OK);

            await fromHome.Closed.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Equal(HubConnectionState.Connected, fromVpn.Connection.State);
        }
        finally
        {
            await admin.PutJsonAsync("/api/admin/network", new { allowedNetworks = Array.Empty<string>() }).ExpectAsync(HttpStatusCode.OK);
        }

        member.Dispose();
    }
}
