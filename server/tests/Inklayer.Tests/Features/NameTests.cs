using System.Net;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

public sealed record NamedMeDto(Guid Id, string DisplayName, string FullName, string? PreferredName);

public sealed record NamedAuthorDto(Guid Id, string DisplayName, string? FullName, string? Role);

public sealed record NamedCommentDto(Guid Id, NamedAuthorDto Author);

/// <summary>People choose the name others see; their real name (from sign-in) and role show on hover.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class NameTests(InklayerApiFactory factory)
{
    [Fact]
    public async Task People_choose_their_shown_name_and_sign_in_never_overwrites_it()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var identity = Identities.Consumer() with { Name = "Ada Lovelace" };
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = identity.Email, role = "Commenter" }).ExpectAsync(HttpStatusCode.Created);
        using var member = await factory.SignInAsync(identity);

        using (var set = await member.PatchJsonAsync("/api/me", new { preferredName = "  Ada  " }))
        {
            var me = await set.ReadAsync<NamedMeDto>();
            Assert.Equal(("Ada", "Ada Lovelace", "Ada"), (me.DisplayName, me.FullName, me.PreferredName));
        }

        // Signing in again with a changed provider name updates the real name only.
        using var again = await factory.SignInAsync(identity with { Name = "Augusta Ada King" });
        using (var me = await again.GetAsync(new Uri("/api/me", UriKind.Relative)))
        {
            var current = await me.ReadAsync<NamedMeDto>();
            Assert.Equal(("Ada", "Augusta Ada King"), (current.DisplayName, current.FullName));
        }

        await member.PatchJsonAsync("/api/me", new { preferredName = new string('x', 81) }).ExpectAsync(HttpStatusCode.BadRequest);
        using (var cleared = await member.PatchJsonAsync("/api/me", new { preferredName = "" }))
        {
            Assert.Equal(("Augusta Ada King", null), ((await cleared.ReadAsync<NamedMeDto>()).DisplayName, (await cleared.ReadAsync<NamedMeDto>()).PreferredName));
        }
    }

    [Fact]
    public async Task Comments_show_the_chosen_name_with_the_real_name_and_role_for_hover()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        var project = await Scenario.CreateProjectAsync(admin, org.Id);
        var identity = Identities.Consumer() with { Name = "Grace Hopper" };
        await admin.PostJsonAsync($"/api/orgs/{org.Id}/invitations", new { email = identity.Email, role = "Commenter" }).ExpectAsync(HttpStatusCode.Created);
        using var member = await factory.SignInAsync(identity);
        using (var me = await member.PatchJsonAsync("/api/me", new { preferredName = "Amazing Grace" }))
        {
            await Scenario.GrantAsync(admin, project.Id, (await me.ReadAsync<NamedMeDto>()).Id, "Commenter");
        }

        using var created = await member.PostJsonAsync($"/api/projects/{project.Id}/live/annotations", new
        {
            url = $"https://site-{Guid.NewGuid():N}.example/", kind = "Pin", body = "Hi",
            anchor = new { element = new { path = new[] { "h1" }, tag = "h1" } }, geometry = new { kind = "Pin", point = new { x = 0.5, y = 0.5 } }, viewportWidth = 1200,
        });
        var comment = await created.ReadAsync<NamedCommentDto>(HttpStatusCode.Created);
        Assert.Equal(("Amazing Grace", "Grace Hopper", "Commenter"), (comment.Author.DisplayName, comment.Author.FullName, comment.Author.Role));
    }
}
