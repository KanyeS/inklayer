using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Auth;

[Collection(ApiTestGroup.Name)]
public sealed class SignInRulesTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task Uninvited_google_account_is_refused()
    {
        Assert.Equal("NotInvited", await factory.TrySignInAsync(Identities.Consumer()));
    }

    [Fact]
    public async Task Unverified_email_is_refused_even_for_a_bootstrap_admin()
    {
        var identity = Identities.Consumer(InklayerApiFactory.BootstrapAdminEmail, subject: "unverified", emailVerified: false);

        Assert.Equal("EmailNotVerified", await factory.TrySignInAsync(identity));
    }

    [Fact]
    public async Task Bootstrap_admin_gets_in_and_is_an_instance_administrator()
    {
        using var admin = await factory.SignInAsAdminAsync();

        using var response = await admin.GetAsync(new Uri("/api/me", UriKind.Relative));
        var me = await response.ReadAsync<MeDto>();

        Assert.True(me.IsSystemAdmin);
        Assert.Equal(InklayerApiFactory.BootstrapAdminEmail, me.Email);
    }

    [Fact]
    public async Task Invited_email_joins_with_the_invited_role_and_the_invitation_is_used_up()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var invitee = Identities.Consumer();
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = invitee.Email.ToUpperInvariant(), role = "Editor" })
            .ExpectAsync(HttpStatusCode.Created);

        using var client = await factory.SignInAsync(invitee);

        using var meResponse = await client.GetAsync(new Uri("/api/me", UriKind.Relative));
        var me = await meResponse.ReadAsync<MeDto>();
        var membership = Assert.Single(me.Organizations);
        Assert.Equal(org.Id, membership.Id);
        Assert.Equal("Editor", membership.Role);

        using var invitations = await admin.GetAsync(new Uri($"/api/orgs/{org.Id}/invitations", UriKind.Relative));
        Assert.Empty(await invitations.ReadAsync<List<InvitationDto>>());
    }

    [Fact]
    public async Task Workspace_domain_users_join_automatically_with_the_default_role()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var domain = $"acme{Guid.NewGuid():N}.test";
        var org = await Scenario.CreateOrganizationAsync(admin, domains: [domain], defaultRole: "Commenter");

        using var client = await factory.SignInAsync(Identities.Workspace(domain));

        using var response = await client.GetAsync(new Uri("/api/me", UriKind.Relative));
        var me = await response.ReadAsync<MeDto>();
        Assert.Contains(me.Organizations, o => o.Id == org.Id && o.Role == "Commenter");
    }

    [Fact]
    public async Task Matching_email_domain_without_the_workspace_claim_is_not_enough()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var domain = $"acme{Guid.NewGuid():N}.test";
        await Scenario.CreateOrganizationAsync(admin, domains: [domain]);

        // A consumer Google account can use any email address. Only the 'hd' claim proves Workspace membership.
        var consumerWithCompanyEmail = Identities.Consumer(Identities.UniqueEmail(domain: domain));

        Assert.Equal("NotInvited", await factory.TrySignInAsync(consumerWithCompanyEmail));
    }

    [Fact]
    public async Task Same_email_from_a_different_google_account_is_refused()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var (_, member) = await Scenario.AddMemberAsync(factory, admin, org.Id, "Viewer");

        var impostor = Identities.Consumer(member.Email, subject: "different-google-account");

        Assert.Equal("AccountConflict", await factory.TrySignInAsync(impostor));
    }
}
