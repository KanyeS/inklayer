using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Inklayer.Infrastructure.Persistence;
using Microsoft.Net.Http.Headers;

namespace Inklayer.Api.Hosting;

/// <summary>
/// For pages that ask again on a timer: the response carries a stamp (ETag) of when the data it depends on last changed,
/// and the browser sends it back (If-None-Match). If nothing changed since, the answer is 304 with no body and the endpoint
/// doesn't run, so an open tab costs a sign-in check instead of the page's queries. Browsers do this on their own for any
/// fetch: the clients needn't change. A stamp is per user and request, and lasts at most <see cref="Lifetime"/>, so anything
/// a write can't flag (an issue's status changing in its tracker) still shows up within that.
/// </summary>
internal static class ChangeStamp
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);

    public static RouteHandlerBuilder WithChangeStamp(this RouteHandlerBuilder builder, ChangeAreas areas) =>
        builder.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var clock = http.RequestServices.GetRequiredService<ChangeClock>();
            var time = http.RequestServices.GetRequiredService<TimeProvider>();

            // Read before the endpoint runs: a change made while it runs gives a newer stamp, so the next ask gets it.
            var stamp = Stamp(http, clock.Boot, clock.Version(areas), time.GetUtcNow());
            http.Response.Headers.CacheControl = "private, no-cache";
            if (http.Request.Headers.IfNoneMatch.Any(v => v is not null && v.Split(',').Any(t => t.Trim() == stamp)))
            {
                http.Response.Headers.ETag = stamp;
                return Results.StatusCode(StatusCodes.Status304NotModified);
            }

            http.Response.OnStarting(() =>
            {
                if (http.Response.StatusCode == StatusCodes.Status200OK)
                {
                    http.Response.Headers.ETag = stamp;
                }

                return Task.CompletedTask;
            });
            return await next(context);
        });

    internal static string Stamp(HttpContext http, Guid boot, long version, DateTimeOffset now)
    {
        var user = http.User.FindFirst(Auth.InklayerClaims.Subject)?.Value ?? "";
        var period = now.ToUnixTimeSeconds() / (long)Lifetime.TotalSeconds;
        var key = string.Join('\n', boot.ToString("N"), version.ToString(CultureInfo.InvariantCulture), period.ToString(CultureInfo.InvariantCulture),
            user, http.Request.Path.Value, http.Request.QueryString.Value);
        return $"W/\"{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 16)}\"";
    }
}
