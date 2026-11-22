using Inklayer.Api.Hosting;
using Microsoft.AspNetCore.Http;
using Serilog.Events;

namespace Inklayer.Tests.Api;

/// <summary>Only failures and slow requests are logged by default: a line per request costs CPU a busy server is short of.</summary>
public sealed class RequestLoggingTests
{
    private static LogEventLevel Level(int status = 200, double ms = 5, bool everyRequest = false, string path = "/api/me", bool refused = false, Exception? ex = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Response.StatusCode = status;
        if (refused)
        {
            context.Items[LoadShedding.RefusedItem] = true;
        }

        return HostingExtensions.RequestLogLevel(context, ms, ex, everyRequest, slowMs: 1000);
    }

    [Fact]
    public void Ordinary_requests_are_not_written_unless_asked_for()
    {
        Assert.Equal(LogEventLevel.Debug, Level());
        Assert.Equal(LogEventLevel.Debug, Level(status: 404));
        Assert.Equal(LogEventLevel.Information, Level(everyRequest: true));
        Assert.Equal(LogEventLevel.Verbose, Level(path: "/health/ready", everyRequest: true));
    }

    [Fact]
    public void Failures_and_slow_requests_are_always_written()
    {
        Assert.Equal(LogEventLevel.Error, Level(status: 500));
        Assert.Equal(LogEventLevel.Error, Level(ex: new InvalidOperationException()));
        Assert.Equal(LogEventLevel.Warning, Level(ms: 1500));
    }

    [Fact]
    public void Refusals_from_an_overloaded_server_are_not_written_one_by_one()
    {
        Assert.Equal(LogEventLevel.Debug, Level(status: 503, refused: true));
    }
}
