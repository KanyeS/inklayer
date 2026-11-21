using System.Net.Http.Headers;
using Inklayer.Api.Access;
using Inklayer.Api.Features.Annotations;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Media;

/// <param name="Kind">fullpage or video.</param>
public sealed record MediaResponse(string Kind, string ContentType, long Size, int Width, int Height);

/// <summary>
/// Large files captured with a comment, kept in the media store: a full-page screenshot (WebP, JPEG or PNG, at most 15 MB)
/// and a recording of the tab (WebM or MP4, at most 40 MB, about a minute).
/// The comment's author adds them; anyone who can see the comment can read them, through the server (never from S3 directly).
/// </summary>
internal static class MediaEndpoints
{
    private static readonly string[] ImageTypes = ["image/webp", "image/jpeg", "image/png"];
    private static readonly string[] VideoTypes = ["video/webm", "video/mp4"];

    public static IEndpointRouteBuilder MapMediaEndpoints(this IEndpointRouteBuilder app)
    {
        var annotations = app.MapGroup("/api/annotations").WithTags("Annotations").RequireAuthorization();
        annotations.MapPut("/{annotationId:guid}/media/{kind}", PutAsync).Produces(StatusCodes.Status204NoContent)
            .WithMetadata(new RequestSizeLimitAttribute(AnnotationMedia.MaxVideoBytes + (1024 * 1024)))
            .WithSummary("Add a file to your comment: kind fullpage (a WebP, JPEG or PNG, at most 15 MB), video (WebM or MP4, at most 40 MB), or thumbnail (the video's still, at most 2 MB)");
        annotations.MapGet("/{annotationId:guid}/media/{kind}", GetAsync).WithSummary("A comment's full-page screenshot (fullpage) or recording (video)");
        return app;
    }

    private static string? Allowed(string kind, string type) => kind switch
    {
        MediaKinds.FullPage when ImageTypes.Contains(type) => null,
        MediaKinds.FullPage => "Send a WebP, JPEG or PNG image.",
        MediaKinds.Thumbnail when ImageTypes.Contains(type) => null,
        MediaKinds.Thumbnail => "Send a WebP, JPEG or PNG image.",
        MediaKinds.Video when VideoTypes.Contains(type) => null,
        MediaKinds.Video => "Send a WebM or MP4 video.",
        _ => "Unknown kind of media.",
    };

    private static long MaxBytes(string kind) => kind switch
    {
        MediaKinds.Video => AnnotationMedia.MaxVideoBytes,
        MediaKinds.Thumbnail => AnnotationMedia.MaxThumbnailBytes,
        _ => AnnotationMedia.MaxImageBytes,
    };

    /// <summary>Whether the file starts the way its type says: an image's signature, WebM's EBML header, or MP4's ftyp box.</summary>
    private static bool LooksLike(string type, byte[] head) => type switch
    {
        "video/webm" => head.Length >= 4 && head[0] == 0x1A && head[1] == 0x45 && head[2] == 0xDF && head[3] == 0xA3,
        "video/mp4" => head.Length >= 8 && head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p',
        _ => ContextEndpoints.LooksLike(type, head),
    };

    private static async Task<IResult> PutAsync(
        Guid annotationId, string kind, HttpRequest request, int? width, int? height, AccessService access, CurrentUser currentUser, InklayerDbContext db,
        IMediaStore store, TimeProvider clock, CancellationToken ct)
    {
        if (await ContextEndpoints.AuthorsCommentAsync(annotationId, access, currentUser, db, ct) is { } denied)
        {
            return denied;
        }

        var type = request.ContentType?.Split(';')[0].Trim().ToLowerInvariant() ?? "";
        if (Allowed(kind, type) is { } refused)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status415UnsupportedMediaType, title: refused);
        }

        var max = MaxBytes(kind);
        if (request.ContentLength > max)
        {
            return TooLarge(max);
        }

        // Into a temporary file first: checked whole before it's stored, and never held in memory.
        var temp = Path.GetTempFileName();
        try
        {
            long size;
            await using (var file = new FileStream(temp, FileMode.Create, FileAccess.ReadWrite, FileShare.None, 81920, FileOptions.Asynchronous))
            {
                var buffer = new byte[81920];
                int read;
                while ((read = await request.Body.ReadAsync(buffer, ct)) > 0)
                {
                    if (file.Length + read > max)
                    {
                        return TooLarge(max);
                    }

                    await file.WriteAsync(buffer.AsMemory(0, read), ct);
                }

                size = file.Length;
                file.Position = 0;
                var head = new byte[16];
                var got = await file.ReadAsync(head, ct);
                if (!LooksLike(type, head[..got]))
                {
                    return TypedResults.Problem(statusCode: StatusCodes.Status415UnsupportedMediaType, title: kind == MediaKinds.Video ? "That isn't a valid video." : "That isn't a valid image.");
                }

                file.Position = 0;
                var key = $"{annotationId}/{kind}-{Guid.CreateVersion7()}.{Annotations.PublicMediaEndpoints.Extension(type)}";
                await store.PutAsync(key, file, type, ct);

                var media = await db.AnnotationMedia.SingleOrDefaultAsync(m => m.AnnotationId == annotationId && m.Kind == kind, ct);
                var old = media?.StorageKey;
                if (media is null)
                {
                    media = new AnnotationMedia { AnnotationId = annotationId, Kind = kind, ContentType = type, StorageKey = key };
                    db.AnnotationMedia.Add(media);
                }

                media.ContentType = type;
                media.StorageKey = key;
                media.Size = size;
                media.Width = Math.Clamp(width ?? 0, 0, 100_000);
                media.Height = Math.Clamp(height ?? 0, 0, 100_000);
                media.CreatedAt = clock.GetUtcNow().UtcDateTime;
                await db.SaveChangesAsync(ct);
                if (old is not null)
                {
                    await store.DeleteAsync(old, ct);
                }
            }

            return TypedResults.NoContent();
        }
        finally
        {
            File.Delete(temp);
        }
    }

    private static async Task<IResult> GetAsync(
        Guid annotationId, string kind, HttpContext http, AccessService access, InklayerDbContext db, IMediaStore store, CancellationToken ct)
    {
        var projectId = await db.Annotations.Where(a => a.Id == annotationId && a.DeletedAt == null).Select(a => (Guid?)a.ProjectId).SingleOrDefaultAsync(ct);
        if (projectId is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(projectId.Value, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var media = await db.AnnotationMedia.AsNoTracking().SingleOrDefaultAsync(m => m.AnnotationId == annotationId && m.Kind == kind, ct);
        if (media is null)
        {
            return TypedResults.NotFound();
        }

        http.Response.Headers.CacheControl = "private, max-age=86400";
        return await SendAsync(http, store, media, ct);
    }

    /// <summary>
    /// Passes a stored file on: the whole of it, or the part a <c>Range</c> header asks for (so videos can be skipped through).
    /// Never run as a page: nosniff, and a sandbox.
    /// </summary>
    internal static async Task<IResult> SendAsync(HttpContext http, IMediaStore store, AnnotationMedia media, CancellationToken ct)
    {
        var headers = http.Response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        headers.AcceptRanges = "bytes";

        long? from = null, to = null;
        if (RangeHeaderValue.TryParse(http.Request.Headers.Range.ToString(), out var range) && range.Unit == "bytes" && range.Ranges.Count == 1)
        {
            var part = range.Ranges.First();
            if (part.From is { } start && start < media.Size)
            {
                from = start;
                to = part.To is { } end ? Math.Min(end, media.Size - 1) : media.Size - 1;
            }
            else if (part.From is null && part.To is { } suffix && suffix > 0)
            {
                from = Math.Max(0, media.Size - suffix);
                to = media.Size - 1;
            }
            else
            {
                headers.ContentRange = $"bytes */{media.Size}";
                return TypedResults.StatusCode(StatusCodes.Status416RangeNotSatisfiable);
            }
        }

        var file = await store.GetAsync(media.StorageKey, from, to, ct);
        if (file is null)
        {
            return TypedResults.NotFound();
        }

        http.Response.RegisterForDisposeAsync(file);
        if (from is { } a && to is { } b)
        {
            http.Response.StatusCode = StatusCodes.Status206PartialContent;
            headers.ContentRange = $"bytes {a}-{b}/{media.Size}";
            http.Response.ContentLength = b - a + 1;
            http.Response.ContentType = media.ContentType;
            await file.Content.CopyToAsync(http.Response.Body, ct);
            return TypedResults.Empty;
        }

        return TypedResults.Stream(file.Content, media.ContentType);
    }

    /// <summary>Each comment's media.</summary>
    internal static async Task<Dictionary<Guid, List<MediaResponse>>> ForAsync(InklayerDbContext db, List<Guid> annotationIds, CancellationToken ct) =>
        (await db.AnnotationMedia.AsNoTracking().Where(m => annotationIds.Contains(m.AnnotationId)).OrderBy(m => m.Kind).ToListAsync(ct))
            .GroupBy(m => m.AnnotationId)
            .ToDictionary(g => g.Key, g => g.Select(m => new MediaResponse(m.Kind, m.ContentType, m.Size, m.Width, m.Height)).ToList());

    private static IResult TooLarge(long max) =>
        TypedResults.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: $"That can be at most {max / (1024 * 1024)} MB.");
}
