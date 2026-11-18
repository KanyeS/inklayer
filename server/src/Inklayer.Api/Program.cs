using Inklayer.Api.Endpoints;
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

    var app = builder.Build();

    app.UseInklayerHosting();
    app.MapInklayerHealthChecks();
    app.MapOpenApi("/openapi/{documentName}.json");
    app.MapSystemEndpoints();

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
