using System.Security.Cryptography;
using Inklayer.Api.Features.Sharing;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Annotations;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Annotations;

/// <summary>
/// Screenshots (and full-page screenshots and videos) put in issues, at public addresses (<c>/media/&lt;token&gt;.png</c>) that trackers can show inline: GitHub, for
/// one, can't take uploads from apps. The token is long and random, made only when a screenshot goes into an issue, and the
/// address stops working when the comment is deleted. No sign-in; rate-limited like share links; never indexed or run.
/// </summary>
internal static class PublicMediaEndpoints
{
    public const string PathPrefix = "/media";

    public static IEndpointRouteBuilder MapPublicMediaEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet($"{PathPrefix}/{{file}}", GetAsync).AllowAnonymous().RequireRateLimiting(PublicShareEndpoints.RateLimitPolicy).ExcludeFromDescription();
        return app;
    }

    /// <summary>A new public token: 32 random bytes, as base64url.</summary>
    public static string NewToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>The file's extension for a content type, for addresses trackers recognise as images.</summary>
    public static string Extension(string contentType) => contentType switch
    {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "video/webm" => "webm",
        "video/mp4" => "mp4",
        _ => "png",
    };

    private static async Task<IResult> GetAsync(
        string file, HttpContext http, InklayerDbContext db, FeatureSwitches features, Media.IMediaStore store, CancellationToken ct)
    {
        var token = file.Split('.')[0];
        if (token.Length is < 40 or > 64 || !await features.IsEnabledAsync(Feature.BugContext, ct))
        {
            return TypedResults.NotFound();
        }

        var screenshot = await (from s in db.AnnotationScreenshots.AsNoTracking()
                                where s.PublicToken == token
                                join a in db.Annotations on s.AnnotationId equals a.Id
                                where a.DeletedAt == null
                                select s).SingleOrDefaultAsync(ct);
        var headers = http.Response.Headers;
        headers["X-Robots-Tag"] = "noindex, nofollow";
        headers["Cross-Origin-Resource-Policy"] = "cross-origin";
        headers.CacheControl = "public, max-age=3600";
        if (screenshot is null)
        {
            // A full-page screenshot or a video, from the media store.
            var media = await (from m in db.AnnotationMedia.AsNoTracking()
                               where m.PublicToken == token
                               join a in db.Annotations on m.AnnotationId equals a.Id
                               where a.DeletedAt == null
                               select m).SingleOrDefaultAsync(ct);
            return media is null ? TypedResults.NotFound() : await Media.MediaEndpoints.SendAsync(http, store, media, ct);
        }

        headers.XContentTypeOptions = "nosniff";
        headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        return TypedResults.File(screenshot.Bytes, screenshot.ContentType);
    }
}
