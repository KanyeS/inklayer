using System.Text.Json.Serialization;
using Inklayer.Api.Activity;
using Inklayer.Api.Auth;
using Inklayer.Api.Endpoints;
using Inklayer.Api.Features.Admin;
using Inklayer.Api.Features.Annotations;
using Inklayer.Api.Features.Docs;
using Inklayer.Api.Features.Issues;
using Inklayer.Api.Features.Live;
using Inklayer.Api.Features.Mcp;
using Inklayer.Api.Features.Notifications;
using Inklayer.Api.Features.Me;
using Inklayer.Api.Features.Organizations;
using Inklayer.Api.Features.Presence;
using Inklayer.Api.Features.Projects;
using Inklayer.Api.Hosting;
using Inklayer.Api.Network;
using Inklayer.Infrastructure;
using Serilog;

Log.Logger = new LoggerConfiguration()
    .WriteTo.Console()
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.AddInklayerObservability();
    builder.Services.AddInklayerInfrastructure(builder.Configuration, builder.Environment.ContentRootPath);
    builder.Services.AddInklayerHosting(builder.Configuration);
    builder.Services.AddInklayerNetworkAccess(builder.Configuration);
    builder.Services.AddInklayerFeatureSwitches(builder.Configuration);
    builder.Services.AddInklayerAuth(builder.Configuration, builder.Environment);
    builder.Services.AddInklayerPresence(builder.Configuration);
    builder.Services.AddInklayerMcp();
    builder.Services.AddInklayerNotifications(builder.Configuration);
    builder.Services.AddInklayerIssues();
    builder.Services.AddValidation();
    builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

    var app = builder.Build();

    app.UseInklayerHosting();
    app.UseViewerApp();
    app.UseInklayerAuth();

    app.MapInklayerHealthChecks();
    app.MapOpenApi("/openapi/{documentName}.json");
    app.MapSystemEndpoints();
    app.MapInklayerAuthEndpoints();
    app.MapMeEndpoints();
    app.MapFeatureEndpoints();
    app.MapAppsEndpoints();
    app.MapOrganizationEndpoints();
    app.MapProjectEndpoints();
    app.MapAdminEndpoints();
    app.MapAnnotationEndpoints();
    app.MapContextEndpoints();
    app.MapNotificationEndpoints();
    app.MapIssueEndpoints();
    app.MapLiveEndpoints();
    app.MapPresenceEndpoints();
    app.MapDocEndpoints();
    app.MapInklayerMcp();
    app.MapActivityEndpoints();
    app.MapViewerFallback();

    await app.RunAsync();
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Inklayer server terminated unexpectedly");
    throw;
}
finally
{
    await Log.CloseAndFlushAsync();
}

/// <summary>Entry point. Declared partial so integration tests can use <c>WebApplicationFactory&lt;Program&gt;</c>.</summary>
public partial class Program;
