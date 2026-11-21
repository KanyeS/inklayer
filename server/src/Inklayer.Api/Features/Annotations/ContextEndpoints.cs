using System.Text.Json;
using Inklayer.Api.Access;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Annotations;

public sealed record ConsoleEntry(string Level, string Message, DateTime? At);

/// <param name="Url">Without its query string.</param>
public sealed record NetworkEntry(string Method, string Url, int Status, int? Ms, DateTime? At);

public sealed record AnnotationContextRequest(
    string? Browser, string? Os, string? UserAgent, int ViewportWidth, int ViewportHeight, double DevicePixelRatio,
    string? Selector, string? ElementHtml, List<ConsoleEntry>? Console, List<NetworkEntry>? Network, double? Zoom = null);

/// <summary>The page as it was when the comment was made.</summary>
public sealed record AnnotationContextResponse(
    string Browser, string Os, string UserAgent, int ViewportWidth, int ViewportHeight, double DevicePixelRatio,
    string Selector, string ElementHtml, IReadOnlyList<ConsoleEntry> Console, IReadOnlyList<NetworkEntry> Network, DateTime CapturedAt, double? Zoom = null);

/// <summary>
/// Bug context: a screenshot and page details the extension captures with a comment (unless the commenter opts out), for
/// whoever fixes it, including AI assistants through MCP. Only the comment's author adds them, right after creating it.
/// </summary>
internal static class ContextEndpoints
{
    private const int MaxEntries = 20;
    private const int MaxMessage = 500;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly string[] ImageTypes = ["image/webp", "image/jpeg", "image/png"];

    public static IEndpointRouteBuilder MapContextEndpoints(this IEndpointRouteBuilder app)
    {
        var annotations = app.MapGroup("/api/annotations").WithTags("Annotations").RequireAuthorization();
        annotations.MapPut("/{annotationId:guid}/context", SetContextAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Add the page details captured with your comment (once)");
        annotations.MapPut("/{annotationId:guid}/screenshot", SetScreenshotAsync).Produces(StatusCodes.Status204NoContent).WithSummary("Add a screenshot to your comment: a WebP, JPEG or PNG body, at most 600 KB");
        annotations.MapGet("/{annotationId:guid}/screenshot", GetScreenshotAsync).WithSummary("The screenshot taken with a comment");
        return app;
    }

    private static async Task<IResult> SetContextAsync(
        Guid annotationId, AnnotationContextRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        if (await AuthorsCommentAsync(annotationId, access, currentUser, db, ct) is { } denied)
        {
            return denied;
        }

        if (await db.AnnotationContexts.AnyAsync(c => c.AnnotationId == annotationId, ct))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status409Conflict, title: "This comment already has its page details.");
        }

        db.AnnotationContexts.Add(new AnnotationContext
        {
            AnnotationId = annotationId,
            Browser = Clip(request.Browser, 100),
            Os = Clip(request.Os, 100),
            UserAgent = Clip(request.UserAgent, 512),
            ViewportWidth = Math.Clamp(request.ViewportWidth, 0, 20000),
            ViewportHeight = Math.Clamp(request.ViewportHeight, 0, 20000),
            DevicePixelRatio = Math.Clamp(request.DevicePixelRatio, 0, 10),
            Zoom = request.Zoom is { } zoom && zoom > 0 ? Math.Clamp(zoom, 0.25, 5) : null,
            Selector = Clip(request.Selector, 2000),
            ElementHtml = Clip(request.ElementHtml, AnnotationContext.MaxHtmlLength),
            Console = Fit((request.Console ?? []).TakeLast(MaxEntries).Select(e => e with { Level = Clip(e.Level, 10), Message = Clip(e.Message, MaxMessage) }).ToList()),
            Network = Fit((request.Network ?? []).TakeLast(MaxEntries).Select(e => e with { Method = Clip(e.Method, 10), Url = WithoutQuery(e.Url) }).ToList()),
            CapturedAt = clock.GetUtcNow().UtcDateTime,
        });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> SetScreenshotAsync(
        Guid annotationId, HttpRequest request, int? width, int? height, AccessService access, CurrentUser currentUser, InklayerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        if (await AuthorsCommentAsync(annotationId, access, currentUser, db, ct) is { } denied)
        {
            return denied;
        }

        var type = request.ContentType?.Split(';')[0].Trim().ToLowerInvariant() ?? "";
        if (!ImageTypes.Contains(type))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status415UnsupportedMediaType, title: "Send a WebP, JPEG or PNG image.");
        }

        if (request.ContentLength > AnnotationScreenshot.MaxBytes)
        {
            return TooLarge();
        }

        using var buffer = new MemoryStream();
        var chunk = new byte[16 * 1024];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > AnnotationScreenshot.MaxBytes)
            {
                return TooLarge();
            }

            buffer.Write(chunk, 0, read);
        }

        var bytes = buffer.ToArray();
        if (!LooksLike(type, bytes))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status415UnsupportedMediaType, title: "That isn't a valid image.");
        }

        var screenshot = await db.AnnotationScreenshots.SingleOrDefaultAsync(s => s.AnnotationId == annotationId, ct);
        if (screenshot is null)
        {
            screenshot = new AnnotationScreenshot { AnnotationId = annotationId, ContentType = type, Bytes = bytes };
            db.AnnotationScreenshots.Add(screenshot);
        }

        screenshot.ContentType = type;
        screenshot.Bytes = bytes;
        screenshot.Width = Math.Clamp(width ?? 0, 0, 10000);
        screenshot.Height = Math.Clamp(height ?? 0, 0, 10000);
        screenshot.CreatedAt = clock.GetUtcNow().UtcDateTime;
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    internal static async Task<IResult> GetScreenshotAsync(Guid annotationId, HttpContext context, AccessService access, InklayerDbContext db, CancellationToken ct)
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

        var screenshot = await db.AnnotationScreenshots.AsNoTracking().SingleOrDefaultAsync(s => s.AnnotationId == annotationId, ct);
        if (screenshot is null)
        {
            return TypedResults.NotFound();
        }

        context.Response.Headers.CacheControl = "private, max-age=86400";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        return TypedResults.File(screenshot.Bytes, screenshot.ContentType);
    }

    /// <summary>The page details of each comment, and which have a screenshot.</summary>
    internal static async Task<(Dictionary<Guid, AnnotationContextResponse> Contexts, HashSet<Guid> Screenshots)> ForAsync(
        InklayerDbContext db, List<Guid> ids, CancellationToken ct)
    {
        var contexts = await db.AnnotationContexts.AsNoTracking().Where(c => ids.Contains(c.AnnotationId)).ToListAsync(ct);
        var screenshots = await db.AnnotationScreenshots.Where(s => ids.Contains(s.AnnotationId)).Select(s => s.AnnotationId).ToListAsync(ct);
        return (contexts.ToDictionary(c => c.AnnotationId, ToResponse), [.. screenshots]);
    }

    internal static AnnotationContextResponse ToResponse(AnnotationContext c) => new(
        c.Browser, c.Os, c.UserAgent, c.ViewportWidth, c.ViewportHeight, c.DevicePixelRatio, c.Selector, c.ElementHtml,
        JsonSerializer.Deserialize<List<ConsoleEntry>>(c.Console, Json) ?? [], JsonSerializer.Deserialize<List<NetworkEntry>>(c.Network, Json) ?? [], c.CapturedAt, c.Zoom);

    /// <summary>Null if the caller wrote this comment (and may still comment in its project); otherwise the error to return.</summary>
    internal static async Task<IResult?> AuthorsCommentAsync(Guid annotationId, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        var annotation = await db.Annotations.AsNoTracking().Where(a => a.Id == annotationId && a.DeletedAt == null)
            .Select(a => new { a.ProjectId, a.AuthorUserId }).SingleOrDefaultAsync(ct);
        if (annotation is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(annotation.ProjectId, Permission.Comment, ct);
        if (!check.IsAllowed)
        {
            return check.Denied;
        }

        return annotation.AuthorUserId == currentUser.Id
            ? null
            : TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only the comment's author can add its screenshot and page details.");
    }

    internal static bool LooksLike(string type, byte[] b) => type switch
    {
        "image/png" => b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47,
        "image/jpeg" => b.Length > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF,
        "image/webp" => b.Length > 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P',
        _ => false,
    };

    private static IResult TooLarge() =>
        TypedResults.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: $"Screenshots can be at most {AnnotationScreenshot.MaxBytes / 1024} KB.");

    private static string Clip(string? value, int max) => value is null ? "" : value.Length > max ? value[..max] : value;

    private static string WithoutQuery(string? url)
    {
        var value = url ?? "";
        var cut = value.IndexOfAny(['?', '#']);
        return Clip(cut >= 0 ? value[..cut] : value, 500);
    }

    /// <summary>JSON within <see cref="AnnotationContext.MaxLogLength"/>, dropping the oldest entries if needed.</summary>
    private static string Fit<T>(List<T> entries)
    {
        while (true)
        {
            var json = JsonSerializer.Serialize(entries, Json);
            if (json.Length <= AnnotationContext.MaxLogLength || entries.Count == 0)
            {
                return json;
            }

            entries.RemoveAt(0);
        }
    }
}
