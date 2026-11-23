using System.Net.Http.Json;
using Inklayer.Api.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;

namespace Inklayer.Tests.Infrastructure;

/// <summary>
/// Boots the real API against a throwaway SQLite file in a temp directory. One instance is shared per test group,
/// so tests use unique emails and names and never assume the database is empty.
/// </summary>
public sealed class InklayerApiFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    public const string BootstrapAdminEmail = "admin@inklayer.test";
    public const string ExtensionRedirectUri = "https://extension-id.chromiumapp.org/";
    public const string TestLoginPath = "/test/login";
    public const string OidcProviderId = "jumpcloud";
    public const string OidcVerifiedDomain = "sso.test";

    /// <summary>The test server has no client address; a request with this header comes from the address it names.</summary>
    public const string ClientIpHeader = "X-Test-Client-Ip";

    private readonly string _dataDirectory = Path.Combine(Path.GetTempPath(), "inklayer-tests", Guid.NewGuid().ToString("N"));

    public string DatabasePath => Path.Combine(_dataDirectory, "inklayer.db");

    /// <summary>The identity provider behind <see cref="OidcProviderId"/>.</summary>
    public FakeOidcProvider Oidc { get; } = new();

    /// <summary>Emails the server sent.</summary>
    public RecordingEmailSender Emails { get; } = new();

    /// <summary>The fake GitHub people connect their own accounts to.</summary>
    public const string GitHubWeb = "https://github-oauth.test";

    public const string GitHubApi = "https://api.github-oauth.test";

    /// <summary>The GitLab and Forgejo instances people connect their own accounts on.</summary>
    public const string GitLabUrl = "https://gitlab-oauth.test";

    public const string ForgejoUrl = "https://forgejo-oauth.test";

    /// <summary>Calls the server made to Slack, webhooks and issue trackers.</summary>
    public FakeOutboundHandler Outbound { get; } = new();

    public Task InitializeAsync() => Task.CompletedTask;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Database", $"Data Source={DatabasePath}");
        builder.UseSetting("Inklayer:Auth:BootstrapAdmins", BootstrapAdminEmail);
        builder.UseSetting("Inklayer:Auth:ExtensionRedirectUris", ExtensionRedirectUri);
        builder.UseSetting("Inklayer:Auth:AllowInsecureHttp", "true");
        builder.UseSetting("Inklayer:Auth:AuthRequestsPerMinute", "100000");
        builder.UseSetting("Inklayer:Sharing:PublicRequestsPerMinute", "100000");
        builder.UseSetting("Inklayer:IpData:Enabled", "false");

        // Two providers, so sign-in shows a chooser. Google's metadata is only fetched on a challenge, which tests don't follow.
        builder.UseSetting("Inklayer:Auth:Google:ClientId", "google-client");
        builder.UseSetting("Inklayer:Auth:Google:ClientSecret", "google-secret");
        builder.UseSetting("Inklayer:Auth:Oidc:0:Id", OidcProviderId);
        builder.UseSetting("Inklayer:Auth:Oidc:0:DisplayName", "JumpCloud");
        builder.UseSetting("Inklayer:Auth:Oidc:0:Authority", FakeOidcProvider.Issuer);
        builder.UseSetting("Inklayer:Auth:Oidc:0:ClientId", FakeOidcProvider.ClientId);
        builder.UseSetting("Inklayer:Auth:Oidc:0:ClientSecret", "oidc-secret");
        builder.UseSetting("Inklayer:Auth:Oidc:0:VerifiedDomains", OidcVerifiedDomain);

        // A GitHub OAuth app, so people can connect their own accounts; repositories on GitHubApi use them.
        builder.UseSetting("Inklayer:Trackers:GitHub:ClientId", "gh-client");
        builder.UseSetting("Inklayer:Trackers:GitHub:ClientSecret", "gh-secret");
        builder.UseSetting("Inklayer:Trackers:GitHub:WebUrl", GitHubWeb);
        builder.UseSetting("Inklayer:Trackers:GitHub:ApiUrl", GitHubApi);
        builder.UseSetting("Inklayer:Trackers:GitLab:ClientId", "gl-client");
        builder.UseSetting("Inklayer:Trackers:GitLab:ClientSecret", "gl-secret");
        builder.UseSetting("Inklayer:Trackers:GitLab:Url", GitLabUrl);
        builder.UseSetting("Inklayer:Trackers:Forgejo:ClientId", "fj-client");
        builder.UseSetting("Inklayer:Trackers:Forgejo:ClientSecret", "fj-secret");
        builder.UseSetting("Inklayer:Trackers:Forgejo:Url", ForgejoUrl);
        builder.UseSetting("Inklayer:Trackers:Linear:ClientId", "ln-client");
        builder.UseSetting("Inklayer:Trackers:Linear:ClientSecret", "ln-secret");
        builder.UseSetting("Inklayer:Trackers:Jira:ClientId", "at-client");
        builder.UseSetting("Inklayer:Trackers:Jira:ClientSecret", "at-secret");
        builder.UseSetting("Inklayer:Trackers:AzureDevOps:ClientId", "az-client");
        builder.UseSetting("Inklayer:Trackers:AzureDevOps:ClientSecret", "az-secret");
        builder.ConfigureServices(services =>
        {
            services.AddSingleton<IStartupFilter, TestClientIpStartupFilter>();
            services.AddSingleton<IStartupFilter, TestLoginStartupFilter>();
        });

        // Configure runs before the handler's post-configuration, which builds the backchannel client from this handler.
        builder.ConfigureTestServices(services =>
        {
            // Every OpenID Connect provider but Google talks to the fake one: the configured one, and any an admin adds in a test.
            services.AddSingleton<Microsoft.Extensions.Options.IConfigureOptions<OpenIdConnectOptions>>(new FakeOidcBackchannel(Oidc));
            services.AddSingleton<Inklayer.Api.Features.Notifications.IEmailSender>(Emails);
            services.AddSingleton<Inklayer.Api.Features.Annotations.INetworkLookup, FakeNetworkLookup>();
            services.AddHttpClient(Inklayer.Api.Features.Notifications.NotificationDispatcher.HttpClientName).ConfigurePrimaryHttpMessageHandler(() => Outbound).SetHandlerLifetime(Timeout.InfiniteTimeSpan);
        });
    }

    /// <summary>A client with its own cookie jar, signed in as <paramref name="identity"/> through the real sign-in rules.</summary>
    public async Task<HttpClient> SignInAsync(ExternalIdentity identity)
    {
        var client = CreateBrowserClient();
        var response = await client.PostAsJsonAsync(TestLoginPath, identity);
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Test sign-in for {identity.Email} was refused: {await response.Content.ReadAsStringAsync()}");
        }

        return client;
    }

    /// <summary>Runs the sign-in rules without throwing. Returns the denial reason, or null if allowed.</summary>
    public async Task<string?> TrySignInAsync(ExternalIdentity identity)
    {
        using var client = CreateBrowserClient();
        var response = await client.PostAsJsonAsync(TestLoginPath, identity);
        return response.IsSuccessStatusCode ? null : await response.Content.ReadAsStringAsync();
    }

    /// <param name="https">Use https, so Secure cookies (such as the OIDC correlation cookie) are sent back.</param>
    public HttpClient CreateBrowserClient(bool https = false)
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
            BaseAddress = new Uri(https ? "https://localhost" : "http://localhost"),
        });
        client.DefaultRequestHeaders.Add(CsrfHeader.Name, "1");
        return client;
    }

    public Task<HttpClient> SignInAsAdminAsync() =>
        SignInAsync(Identities.Consumer(BootstrapAdminEmail, subject: "bootstrap-admin-subject"));

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();
        Oidc.Dispose();
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dataDirectory))
        {
            Directory.Delete(_dataDirectory, recursive: true);
        }
    }

    /// <summary>Sets the connection's remote address from <see cref="ClientIpHeader"/>, as Kestrel would from the socket.</summary>
    private sealed class TestClientIpStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Use((context, nextMiddleware) =>
            {
                if (System.Net.IPAddress.TryParse(context.Request.Headers[ClientIpHeader].ToString(), out var address))
                {
                    context.Connection.RemoteIpAddress = address;
                }

                return nextMiddleware(context);
            });
            next(app);
        };
    }

    /// <summary>Test-only replacement for the providers' callbacks: runs <see cref="SignInService"/> and issues the real session cookie.</summary>
    private sealed class TestLoginStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Map(TestLoginPath, login => login.Run(async context =>
            {
                var identity = await context.Request.ReadFromJsonAsync<ExternalIdentity>();
                var decision = await context.RequestServices.GetRequiredService<SignInService>().SignInAsync(identity!, context.RequestAborted);
                if (!decision.IsAllowed)
                {
                    context.Response.StatusCode = StatusCodes.Status403Forbidden;
                    await context.Response.WriteAsync(decision.DenialReason.ToString()!);
                    return;
                }

                await context.SignInAsync(AuthSchemes.Cookie, PrincipalFactory.CreateCookiePrincipal(decision.User!));
                context.Response.StatusCode = StatusCodes.Status204NoContent;
            }));
            next(app);
        };
    }
}

[CollectionDefinition(Name)]
public sealed class ApiTestGroup : ICollectionFixture<InklayerApiFactory>
{
    public const string Name = "api";
}

/// <summary>Points every OpenID Connect scheme except Google at <see cref="FakeOidcProvider"/>.</summary>
internal sealed class FakeOidcBackchannel(FakeOidcProvider provider) : Microsoft.Extensions.Options.IConfigureNamedOptions<OpenIdConnectOptions>
{
    public void Configure(string? name, OpenIdConnectOptions options)
    {
        if (name != AuthSchemes.Google)
        {
            options.BackchannelHttpHandler = provider;
        }
    }

    public void Configure(OpenIdConnectOptions options) => Configure(Microsoft.Extensions.Options.Options.DefaultName, options);
}
