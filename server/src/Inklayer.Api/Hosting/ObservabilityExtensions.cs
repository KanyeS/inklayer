using OpenTelemetry;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;
using Serilog.Formatting.Compact;

namespace Inklayer.Api.Hosting;

internal static class ObservabilityExtensions
{
    public const string ServiceName = "inklayer-server";

    /// <summary>
    /// Sets up Serilog: readable console output in Development, compact JSON everywhere else.
    /// Also sets up OpenTelemetry traces and metrics. They are only exported when
    /// <c>OTEL_EXPORTER_OTLP_ENDPOINT</c> is set, so a plain install sends nothing.
    /// </summary>
    public static WebApplicationBuilder AddInklayerObservability(this WebApplicationBuilder builder)
    {
        var isDevelopment = builder.Environment.IsDevelopment();

        builder.Services.AddSerilog((services, logger) =>
        {
            logger.ReadFrom.Configuration(builder.Configuration)
                .ReadFrom.Services(services)
                .Enrich.FromLogContext();

            if (isDevelopment)
            {
                logger.WriteTo.Console();
            }
            else
            {
                logger.WriteTo.Console(new RenderedCompactJsonFormatter());
            }
        });

        // Traces and metrics are only collected when there's somewhere to send them: collecting them for nobody costs
        // CPU on every request.
        if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"]))
        {
            builder.Services.AddOpenTelemetry()
                .ConfigureResource(r => r.AddService(ServiceName, serviceVersion: AppVersion.Current))
                .WithTracing(t => t
                    .AddAspNetCoreInstrumentation(o => o.Filter = ctx => !ctx.Request.Path.StartsWithSegments("/health", StringComparison.Ordinal))
                    .AddHttpClientInstrumentation())
                .WithMetrics(m => m
                    .AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddMeter("System.Runtime"))
                .UseOtlpExporter();
        }

        return builder;
    }
}
