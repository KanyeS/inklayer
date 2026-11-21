using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Inklayer.Api.Features.Notifications;
using Inklayer.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Features;

public sealed record InboxItemDto(Guid Id, string Kind, Guid? AnnotationId, Guid? DocId, string Preview, bool Read);

public sealed record InboxDto(int Unread, List<InboxItemDto> Items);

public sealed record PersonDto(Guid Id, string DisplayName, string FullName);

public sealed record IntegrationDto(Guid Id, string Kind, string Name, bool Enabled, string? Target, string? LastError);

public sealed record IntegrationCreatedDto(IntegrationDto Integration, string? Secret);

/// <summary>@mentions, the in-app inbox, and organisations' email, Slack and webhook integrations.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class NotificationTests(InklayerApiFactory factory)
{
    private sealed record Org(HttpClient Admin, Guid Id, Guid ProjectId, HttpClient Ana, MeDto AnaMe, HttpClient Ben, MeDto BenMe, HttpClient Cy, MeDto CyMe) : IDisposable
    {
        public void Dispose()
        {
            Admin.Dispose();
            Ana.Dispose();
            Ben.Dispose();
            Cy.Dispose();
        }
    }

    private async Task<Org> OrgAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var (ana, anaMe) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var (ben, benMe) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Commenter");
        var (cy, cyMe) = await Scenario.AddProjectMemberAsync(factory, admin, org.Id, "Viewer");
        return new Org(admin, org.Id, project.Id, ana, anaMe, ben, benMe, cy, cyMe);
    }

    private static async Task<Guid> CommentAsync(HttpClient client, Guid projectId, string body)
    {
        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/live/annotations", new
        {
            url = $"https://site-{Guid.NewGuid():N}.example/page", kind = "Pin", body,
            anchor = new { element = new { path = new[] { "h1" }, tag = "h1" } }, geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } }, viewportWidth = 1200,
        });
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return json.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task<InboxDto> InboxAsync(HttpClient client)
    {
        using var response = await client.GetAsync(new Uri("/api/notifications", UriKind.Relative));
        return await response.ReadAsync<InboxDto>();
    }

    [Fact]
    public async Task Mentions_reach_the_people_mentioned_and_show_their_names()
    {
        using var org = await OrgAsync();
        using var other = await OrgAsync();
        var outsider = other.AnaMe;

        var commentId = await CommentAsync(org.Ana, org.ProjectId, $"<@{org.BenMe.Id}> can you check this? cc <@{outsider.Id}>");

        var inbox = await InboxAsync(org.Ben);
        Assert.Equal(1, inbox.Unread);
        var item = Assert.Single(inbox.Items);
        Assert.Equal(("mention", commentId), (item.Kind, item.AnnotationId));
        Assert.StartsWith($"@{org.BenMe.DisplayName} can you check this?", item.Preview, StringComparison.Ordinal);
        Assert.Empty((await InboxAsync(org.Ana)).Items); // not for your own comment
        Assert.Empty((await InboxAsync(other.Ana)).Items); // not outside the organisation

        await org.Ben.PostJsonAsync("/api/notifications/read", new { all = true }).ExpectAsync(HttpStatusCode.NoContent);
        Assert.Equal(0, (await InboxAsync(org.Ben)).Unread);
    }

    [Fact]
    public async Task People_in_a_thread_hear_about_replies_and_authors_about_resolving()
    {
        using var org = await OrgAsync();
        var commentId = await CommentAsync(org.Ana, org.ProjectId, "The header overlaps");
        await org.Ben.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = "Agreed" }).ExpectAsync(HttpStatusCode.Created);
        await org.Ana.PostJsonAsync($"/api/annotations/{commentId}/replies", new { body = $"Thanks <@{org.CyMe.Id}>" }).ExpectAsync(HttpStatusCode.Created);

        Assert.Equal(["reply"], (await InboxAsync(org.Ana)).Items.Select(i => i.Kind)); // Ben's reply
        Assert.Equal(["reply"], (await InboxAsync(org.Ben)).Items.Select(i => i.Kind)); // Ana's reply, in Ben's thread
        Assert.Equal(["mention"], (await InboxAsync(org.Cy)).Items.Select(i => i.Kind)); // mentioned, not also "reply"

        await org.Ben.PatchJsonAsync($"/api/annotations/{commentId}", new { version = 1, status = "Resolved" }).ExpectAsync(HttpStatusCode.OK);
        Assert.Contains("resolved", (await InboxAsync(org.Ana)).Items.Select(i => i.Kind));
    }

    [Fact]
    public async Task Mentions_added_to_a_doc_notify_once()
    {
        using var org = await OrgAsync();
        using var created = await org.Ana.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = "Launch" });
        var docId = (await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created)).Id;
        await using var live = await DocsProbe.ConnectAsync(factory, org.Ana);
        await live.OpenAsync(docId);
        await live.UpdateAsync(docId, 1);

        Assert.True(await live.SnapshotAsync(docId, [1], $"Owner: <@{org.BenMe.Id}>", 1));
        await live.UpdateAsync(docId, 2);
        Assert.True(await live.SnapshotAsync(docId, [2], $"Owner: <@{org.BenMe.Id}> (confirmed)", 2)); // same mention: no new notification

        var item = Assert.Single((await InboxAsync(org.Ben)).Items);
        Assert.Equal(("mention", docId), (item.Kind, item.DocId));
        Assert.Equal($"Owner: @{org.BenMe.DisplayName}", item.Preview);
    }

    [Fact]
    public async Task Members_are_suggested_by_either_name()
    {
        using var org = await OrgAsync();
        await org.Ben.PatchJsonAsync("/api/me", new { preferredName = "Benny Bluebird" }).ExpectAsync(HttpStatusCode.OK);

        using var byChosen = await org.Ana.GetAsync(new Uri($"/api/orgs/{org.Id}/members/lookup?q=bluebird", UriKind.Relative));
        Assert.Equal(org.BenMe.Id, Assert.Single(await byChosen.ReadAsync<List<PersonDto>>()).Id);
        using var byReal = await org.Ana.GetAsync(new Uri($"/api/orgs/{org.Id}/members/lookup?q={Uri.EscapeDataString(org.BenMe.DisplayName)}", UriKind.Relative));
        Assert.Contains(await byReal.ReadAsync<List<PersonDto>>(), p => p.Id == org.BenMe.Id);
    }

    [Fact]
    public async Task Integrations_send_to_slack_signed_webhooks_and_email_and_keep_trying()
    {
        using var org = await OrgAsync();
        var slackUrl = $"https://hooks.slack.test/services/{Guid.NewGuid():N}/abcd";
        var hookUrl = $"https://hooks.example.test/{Guid.NewGuid():N}";
        var brokenUrl = $"https://broken.example.test/{Guid.NewGuid():N}";
        factory.Outbound.Responders[brokenUrl] = (_, _) => new HttpResponseMessage(HttpStatusCode.InternalServerError) { Content = new StringContent("boom") };

        await org.Ana.PostJsonAsync($"/api/orgs/{org.Id}/integrations", new { kind = "slack", url = slackUrl }).ExpectAsync(HttpStatusCode.Forbidden);
        await org.Admin.PostJsonAsync($"/api/orgs/{org.Id}/integrations", new { kind = "slack", url = "http://insecure.test/x" }).ExpectAsync(HttpStatusCode.BadRequest);
        using (var slack = await org.Admin.PostJsonAsync($"/api/orgs/{org.Id}/integrations", new { kind = "slack", name = "#design", url = slackUrl, events = new[] { "comment.created" } }))
        {
            var created = await slack.ReadAsync<IntegrationCreatedDto>(HttpStatusCode.Created);
            Assert.Equal("hooks.slack.test/…/abcd", created.Integration.Target); // never the whole secret address
            Assert.Null(created.Secret);
        }

        string secret;
        using (var hook = await org.Admin.PostJsonAsync($"/api/orgs/{org.Id}/integrations", new { kind = "webhook", url = hookUrl }))
        {
            secret = (await hook.ReadAsync<IntegrationCreatedDto>(HttpStatusCode.Created)).Secret!;
        }

        await org.Admin.PostJsonAsync($"/api/orgs/{org.Id}/integrations", new { kind = "webhook", name = "Broken", url = brokenUrl }).ExpectAsync(HttpStatusCode.Created);
        await org.Admin.PostJsonAsync($"/api/orgs/{org.Id}/integrations", new { kind = "email" }).ExpectAsync(HttpStatusCode.Created);
        await org.Cy.PatchJsonAsync("/api/me", new { emailNotifications = false }).ExpectAsync(HttpStatusCode.OK);

        await CommentAsync(org.Ana, org.ProjectId, $"Look <@{org.BenMe.Id}> and <@{org.CyMe.Id}>");
        await factory.Services.GetRequiredService<NotificationDispatcher>().RunOnceAsync(CancellationToken.None);

        var slackPost = Assert.Single(factory.Outbound.To(slackUrl));
        Assert.Contains("commented on", slackPost.Body, StringComparison.Ordinal);
        Assert.Contains($"@{org.BenMe.DisplayName}", slackPost.Body, StringComparison.Ordinal);

        var hooks = factory.Outbound.To(hookUrl).ToList();
        Assert.Equal(["comment.created", "mention"], hooks.Select(h => h.Request.Headers.GetValues("X-Inklayer-Event").Single()).Order());
        foreach (var (request, body) in hooks)
        {
            var expected = "sha256=" + Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(body)));
            Assert.Equal(expected, request.Headers.GetValues("X-Inklayer-Signature").Single());
        }

        Assert.Contains(factory.Emails.Sent, e => e.To == org.BenMe.Email && e.Subject.Contains("mentioned you", StringComparison.Ordinal));
        Assert.DoesNotContain(factory.Emails.Sent, e => e.To == org.CyMe.Email); // turned emails off

        using var list = await org.Admin.GetAsync(new Uri($"/api/orgs/{org.Id}/integrations", UriKind.Relative));
        var broken = (await list.ReadAsync<List<IntegrationDto>>()).Single(i => i.Name == "Broken");
        Assert.Contains("500", broken.LastError, StringComparison.Ordinal); // kept for a retry later, and shown to admins
    }
}
