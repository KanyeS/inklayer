using System.Text.Json.Serialization;
using Inklayer.Api.Auth;
using Inklayer.Api.Endpoints;
using Inklayer.Api.Features.Admin;
using Inklayer.Api.Features.Me;
using Inklayer.Api.Features.Organizations;
using Inklayer.Api.Features.Projects;
using Inklayer.Api.Features.Snapshots;
using Inklayer.Api.Hosting;
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
    builder.Services.AddInklayerAuth(builder.Configuration, builder.Environment);
    builder.Services.AddOptions<SnapshotOptions>().Bind(builder.Configuration.GetSection(SnapshotOptions.SectionName));
    builder.Services.AddSingleton<SnapshotLinks>();
    builder.Services.AddValidation();
    builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));

    var app = builder.Build();

    app.UseInklayerHosting();
    app.UseSnapshotOrigin();
    app.UseInklayerAuth();

    app.MapInklayerHealthChecks();
    app.MapOpenApi("/openapi/{documentName}.json");
    app.MapSystemEndpoints();
    app.MapInklayerAuthEndpoints();
    app.MapMeEndpoints();
    app.MapOrganizationEndpoints();
    app.MapProjectEndpoints();
    app.MapAdminEndpoints();
    app.MapSnapshotEndpoints();

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
