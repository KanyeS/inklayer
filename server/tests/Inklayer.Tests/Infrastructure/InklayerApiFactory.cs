using System.Net.Http.Json;
using Inklayer.Api.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Testing;
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
    public const string SnapshotOrigin = "http://snapshots.localhost";

    private readonly string _dataDirectory = Path.Combine(Path.GetTempPath(), "inklayer-tests", Guid.NewGuid().ToString("N"));

    public string DatabasePath => Path.Combine(_dataDirectory, "inklayer.db");

    public Task InitializeAsync() => Task.CompletedTask;

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.UseSetting("ConnectionStrings:Database", $"Data Source={DatabasePath}");
        builder.UseSetting("Inklayer:Auth:BootstrapAdmins", BootstrapAdminEmail);
        builder.UseSetting("Inklayer:Auth:ExtensionRedirectUris", ExtensionRedirectUri);
        builder.UseSetting("Inklayer:Auth:AllowInsecureHttp", "true");
        builder.UseSetting("Inklayer:Auth:AuthRequestsPerMinute", "100000");
        builder.UseSetting("Inklayer:Snapshots:Origin", SnapshotOrigin);
        builder.UseSetting("Inklayer:Snapshots:AppOrigin", "http://localhost");
        builder.UseSetting("Inklayer:Snapshots:MaxBlobBytes", "1048576");
        builder.ConfigureServices(services => services.AddSingleton<IStartupFilter, TestLoginStartupFilter>());
    }

    /// <summary>A client with its own cookie jar, signed in as <paramref name="identity"/> through the real sign-in rules.</summary>
    public async Task<HttpClient> SignInAsync(GoogleIdentity identity)
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
    public async Task<string?> TrySignInAsync(GoogleIdentity identity)
    {
        using var client = CreateBrowserClient();
        var response = await client.PostAsJsonAsync(TestLoginPath, identity);
        return response.IsSuccessStatusCode ? null : await response.Content.ReadAsStringAsync();
    }

    public HttpClient CreateBrowserClient()
    {
        var client = CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false, HandleCookies = true });
        client.DefaultRequestHeaders.Add(CsrfHeader.Name, "1");
        return client;
    }

    public Task<HttpClient> SignInAsAdminAsync() =>
        SignInAsync(Identities.Consumer(BootstrapAdminEmail, subject: "bootstrap-admin-subject"));

    async Task IAsyncLifetime.DisposeAsync()
    {
        await base.DisposeAsync();
        SqliteConnection.ClearAllPools();
        if (Directory.Exists(_dataDirectory))
        {
            Directory.Delete(_dataDirectory, recursive: true);
        }
    }

    /// <summary>Test-only replacement for the Google callback: runs <see cref="SignInService"/> and issues the real session cookie.</summary>
    private sealed class TestLoginStartupFilter : IStartupFilter
    {
        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
        {
            app.Map(TestLoginPath, login => login.Run(async context =>
            {
                var identity = await context.Request.ReadFromJsonAsync<GoogleIdentity>();
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
