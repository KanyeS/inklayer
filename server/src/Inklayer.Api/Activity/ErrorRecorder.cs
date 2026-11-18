using System.Security.Claims;
using Inklayer.Api.Auth;
using Inklayer.Domain.Auditing;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Activity;

/// <summary>
/// Records unhandled exceptions for the instance administrators' activity log, then lets the default handler write the usual
/// problem response. It saves in its own scope (the request's database context may be in a broken state), and never lets a
/// failure to record mask the original error.
/// </summary>
internal sealed partial class ErrorRecorder(IServiceScopeFactory scopes, TimeProvider clock, ILogger<ErrorRecorder> logger) : IExceptionHandler
{
    private static long lastPrune;

    public async ValueTask<bool> TryHandleAsync(HttpContext httpContext, Exception exception, CancellationToken cancellationToken)
    {
        if (exception is OperationCanceledException && httpContext.RequestAborted.IsCancellationRequested)
        {
            return false; // the client went away; not an error worth showing
        }

        try
        {
            var now = clock.GetUtcNow().UtcDateTime;
            var message = $"{exception.GetType().Name}: {exception.Message}";
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
            db.ErrorEvents.Add(new ErrorEvent
            {
                OccurredAt = now,
                UserId = Guid.TryParse(httpContext.User.FindFirstValue(InklayerClaims.Subject), out var id) ? id : null,
                Method = httpContext.Request.Method,
                Path = httpContext.Request.Path.Value is { Length: > 0 } path ? path[..Math.Min(path.Length, 2048)] : "/",
                StatusCode = StatusCodes.Status500InternalServerError,
                Message = message.Length > ErrorEvent.MaxMessageLength ? message[..ErrorEvent.MaxMessageLength] : message,
                TraceId = System.Diagnostics.Activity.Current?.TraceId.ToString() ?? httpContext.TraceIdentifier,
            });
            await db.SaveChangesAsync(CancellationToken.None);

            // Keep the table small: at most once an hour, drop entries past the retention period.
            var hour = now.Ticks / TimeSpan.TicksPerHour;
            if (Interlocked.Exchange(ref lastPrune, hour) != hour)
            {
                var cutoff = now - ErrorEvent.Retention;
                await db.ErrorEvents.Where(e => e.OccurredAt < cutoff).ExecuteDeleteAsync(CancellationToken.None);
            }
        }
#pragma warning disable CA1031 // Recording must never hide the original error.
        catch (Exception recordingFailure)
#pragma warning restore CA1031
        {
            LogRecordingFailed(logger, recordingFailure);
        }

        return false;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Couldn't record a server error in the activity log")]
    private static partial void LogRecordingFailed(ILogger logger, Exception exception);
}
