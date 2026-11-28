using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Inklayer.Api.Features.Issues;
using Inklayer.Domain.Issues;
using Inklayer.Tests.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace Inklayer.Tests.Features;

/// <summary>Instance administrators set up tracker OAuth apps on the Admin page, without touching the server's configuration.</summary>
[Collection(ApiTestGroup.Name)]
public sealed class TrackerAppTests(InklayerApiFactory factory)
{
    private const string Path = "/api/admin/tracker-apps";

    [Fact]
    public async Task Every_tracker_is_listed_with_where_its_app_is_set_up_and_the_callback_to_register()
    {
        using var admin = await factory.SignInAsAdminAsync();

        var apps = await admin.GetFromJsonAsync<JsonElement>(new Uri(Path, UriKind.Relative));

        var github = apps.EnumerateArray().Single(a => a.GetProperty("kind").GetString() == TrackerKinds.GitHub);
        Assert.Equal("Config", github.GetProperty("source").GetString());
        Assert.Equal("http://localhost/api/me/tracker-accounts/github/callback", github.GetProperty("callbackUrl").GetString());
        Assert.Equal(6, apps.GetArrayLength());
        Assert.DoesNotContain("gh-secret", apps.GetRawText(), StringComparison.Ordinal);
        Assert.DoesNotContain("gh-client", apps.GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Apps_from_the_configuration_cant_be_changed_or_removed_here()
    {
        using var admin = await factory.SignInAsAdminAsync();

        using var change = await admin.PutAsJsonAsync($"{Path}/github", new { clientId = "other", clientSecret = "other" });
        using var remove = await admin.DeleteAsync(new Uri($"{Path}/github", UriKind.Relative));
        using var unknown = await admin.PutAsJsonAsync($"{Path}/trello", new { clientId = "x", clientSecret = "y" });

        Assert.Equal(HttpStatusCode.Conflict, change.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, remove.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
    }

    [Fact]
    public async Task Only_instance_administrators_can_see_or_change_tracker_apps()
    {
        using var admin = await factory.SignInAsAdminAsync();
        var (person, _) = await Scenario.AddMemberAsync(factory, admin, (await Scenario.CreateOrganizationAsync(admin)).Id, "Owner");

        using var list = await person.GetAsync(new Uri(Path, UriKind.Relative));
        using var change = await person.PutAsJsonAsync($"{Path}/linear", new { clientId = "x", clientSecret = "y" });

        Assert.Equal(HttpStatusCode.Forbidden, list.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, change.StatusCode);
    }

    [Fact]
    public async Task An_added_app_works_straight_away_keeps_its_secret_and_is_loaded_again_on_restart()
    {
        var apps = Store(new TrackerOAuthOptions());
        await apps.StartAsync(CancellationToken.None);
        var adminId = Guid.NewGuid();
        try
        {
            Assert.Equal(TrackerAppSource.None, apps.Source(TrackerKinds.Linear));

            await apps.SaveAsync(TrackerKinds.Linear, "ln-added", "ln-added-secret", null, null, adminId, CancellationToken.None);
            await apps.SaveAsync(TrackerKinds.GitHub, "gh-added", "gh-added-secret", "https://github.acme.test", null, adminId, CancellationToken.None);
            await apps.SaveAsync(TrackerKinds.GitLab, "gl-added", "gl-added-secret", "https://gitlab.acme.test", null, adminId, CancellationToken.None);

            Assert.Equal(TrackerAppSource.Admin, apps.Source(TrackerKinds.Linear));
            Assert.Equal(("ln-added", "ln-added-secret"), (apps.Current.Linear.ClientId, apps.Current.Linear.ClientSecret));
            Assert.Equal("https://github.acme.test/api/v3", apps.Current.GitHub.ApiUrl);
            Assert.Equal("https://gitlab.acme.test", apps.Current.GitLab.Url);

            // Saving without a secret keeps the one there.
            await apps.SaveAsync(TrackerKinds.Linear, "ln-renamed", null, null, null, adminId, CancellationToken.None);
            Assert.Equal(("ln-renamed", "ln-added-secret"), (apps.Current.Linear.ClientId, apps.Current.Linear.ClientSecret));

            // A fresh store reads what was saved, as a restarted server does, and can decrypt the secrets.
            var restarted = Store(new TrackerOAuthOptions());
            await restarted.StartAsync(CancellationToken.None);
            Assert.Equal("ln-added-secret", restarted.Current.Linear.ClientSecret);
            Assert.Equal("https://gitlab.acme.test", restarted.Current.GitLab.Url);

            // The configuration wins over an added app for the same tracker.
            var configured = Store(new TrackerOAuthOptions { Linear = new() { ClientId = "from-config", ClientSecret = "config-secret" } });
            await configured.StartAsync(CancellationToken.None);
            Assert.Equal(TrackerAppSource.Config, configured.Source(TrackerKinds.Linear));
            Assert.Equal("from-config", configured.Current.Linear.ClientId);

            await apps.RemoveAsync(TrackerKinds.Linear, adminId, CancellationToken.None);
            Assert.Equal(TrackerAppSource.None, apps.Source(TrackerKinds.Linear));
            Assert.False(apps.Current.Linear.IsConfigured);
        }
        finally
        {
            foreach (var kind in new[] { TrackerKinds.Linear, TrackerKinds.GitHub, TrackerKinds.GitLab })
            {
                await apps.RemoveAsync(kind, adminId, CancellationToken.None);
            }
        }
    }

    private TrackerOAuthApps Store(TrackerOAuthOptions configured) =>
        ActivatorUtilities.CreateInstance<TrackerOAuthApps>(factory.Services, Options.Create(configured));
}
