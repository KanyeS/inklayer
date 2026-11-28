using System.ComponentModel.DataAnnotations;
using System.Text.RegularExpressions;
using Inklayer.Api.Access;
using Inklayer.Api.Features.Media;
using Inklayer.Api.Hosting;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Docs;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Docs;

/// <param name="DocIds">The docs on the board's cards.</param>
public sealed record BoardCardsRequest(IReadOnlyList<Guid> DocIds);

/// <summary>A doc on a board's card: enough to draw the card without opening the doc.</summary>
/// <param name="Excerpt">The start of its markdown, as of its last save.</param>
public sealed record BoardDocCardResponse(
    Guid Id, Guid OrganizationId, string Folder, string Title, [property: AllowedValues("doc", "board", "kanban")] string Kind, string? Icon, string? Color,
    DateTime UpdatedAt, string Excerpt);

/// <param name="Id">The picture's id on the board, for its card: <c>/api/boards/{boardId}/media/{id}</c>.</param>
public sealed record BoardMediaResponse(string Id);

/// <summary>
/// What boards need beyond the docs hub. A board is a doc of kind "board" (see <see cref="Doc.Kind"/>): its cards and
/// arrows are in its Yjs document, which the server only relays. These addresses are under /api/boards, so they answer only
/// while boards (and docs) are turned on.
/// </summary>
internal static partial class BoardEndpoints
{
    public const int MaxCards = 500;
    public const int ExcerptLength = 600;
    public const long MaxImageBytes = 10 * 1024 * 1024;

    private static readonly Dictionary<string, string> ImageTypes = new()
    {
        ["image/png"] = "png",
        ["image/jpeg"] = "jpg",
        ["image/webp"] = "webp",
        ["image/gif"] = "gif",
    };

    public static IEndpointRouteBuilder MapBoardEndpoints(this IEndpointRouteBuilder app)
    {
        var boards = app.MapGroup("/api/boards").WithTags("Boards").RequireAuthorization();
        boards.MapPost("/{boardId:guid}/cards", CardsAsync).Produces<List<BoardDocCardResponse>>()
            .WithSummary("The docs on a board's cards that the caller can open, with the start of each one's text");
        boards.MapPost("/{boardId:guid}/media", UploadAsync).Produces<BoardMediaResponse>(StatusCodes.Status201Created)
            .WithMetadata(new RequestSizeLimitAttribute(MaxImageBytes + (64 * 1024)))
            .WithSummary("Add a picture to the board (Commenter and above): PNG, JPEG, WebP or GIF, at most 10 MB, sent as the body");
        boards.MapGet("/{boardId:guid}/media/{mediaId}", MediaAsync).WithSummary("A picture on the board");
        boards.MapGet("/{boardId:guid}/link-preview", LinkPreviewAsync).Produces<LinkPreviewResponse>()
            .WithSummary("A web page's title, description and picture, for a link card: ?url=");
        return app;
    }

    /// <summary>A picture's id: a new id and the file type, e.g. <c>0193…e1.webp</c>.</summary>
    [GeneratedRegex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(png|jpg|webp|gif)$")]
    private static partial Regex MediaId();

    private static string MediaKey(Guid boardId, string mediaId) => $"boards/{boardId:N}/{mediaId}";

    private static async Task<IResult> UploadAsync(
        Guid boardId, HttpRequest request, AccessService access, InklayerDbContext db, IMediaStore store, CancellationToken ct)
    {
        if (await BoardAsync(boardId, Permission.Comment, access, db, ct) is { } denied)
        {
            return denied;
        }

        var type = request.ContentType?.Split(';')[0].Trim().ToLowerInvariant() ?? "";
        if (!ImageTypes.TryGetValue(type, out var extension))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status415UnsupportedMediaType, title: "Add a PNG, JPEG, WebP or GIF picture.");
        }

        if (request.ContentLength > MaxImageBytes)
        {
            return TooLarge();
        }

        // Read whole (at most 10 MB) and checked before it's stored.
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await request.Body.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > MaxImageBytes)
            {
                return TooLarge();
            }

            buffer.Write(chunk, 0, read);
        }

        var head = buffer.GetBuffer().AsSpan(0, (int)Math.Min(16, buffer.Length)).ToArray();
        if (!LooksLike(type, head))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status415UnsupportedMediaType, title: "That isn't a valid picture.");
        }

        var id = $"{Guid.CreateVersion7()}.{extension}";
        buffer.Position = 0;
        await store.PutAsync(MediaKey(boardId, id), buffer, type, ct);
        return TypedResults.Created($"/api/boards/{boardId}/media/{id}", new BoardMediaResponse(id));
    }

    private static async Task<IResult> MediaAsync(
        Guid boardId, string mediaId, HttpContext http, AccessService access, InklayerDbContext db, IMediaStore store, CancellationToken ct)
    {
        if (!MediaId().IsMatch(mediaId))
        {
            return TypedResults.NotFound();
        }

        if (await BoardAsync(boardId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        var file = await store.GetAsync(MediaKey(boardId, mediaId), null, null, ct);
        if (file is null || !ImageTypes.ContainsKey(file.ContentType))
        {
            if (file is not null)
            {
                await file.DisposeAsync();
            }

            return TypedResults.NotFound();
        }

        http.Response.RegisterForDisposeAsync(file);
        var headers = http.Response.Headers;
        headers.XContentTypeOptions = "nosniff";
        headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        headers.CacheControl = "private, max-age=604800, immutable"; // a picture's id never points at another picture
        return TypedResults.Stream(file.Content, file.ContentType);
    }

    private static async Task<IResult> LinkPreviewAsync(
        Guid boardId, string? url, AccessService access, InklayerDbContext db, LinkPreviewer previewer, CancellationToken ct)
    {
        if (await BoardAsync(boardId, Permission.Comment, access, db, ct) is { } denied)
        {
            return denied;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["url"] = ["Give an http or https address."] });
        }

        return TypedResults.Ok(await previewer.PreviewAsync(uri, ct));
    }

    private static bool LooksLike(string type, byte[] head) =>
        type == "image/gif"
            ? head.Length >= 6 && head[0] == 'G' && head[1] == 'I' && head[2] == 'F' && head[3] == '8'
            : Annotations.ContextEndpoints.LooksLike(type, head);

    private static IResult TooLarge() =>
        TypedResults.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: "Pictures can be at most 10 MB.");

    private static async Task<IResult> CardsAsync(
        Guid boardId, BoardCardsRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct)
    {
        if (await BoardAsync(boardId, Permission.View, access, db, ct) is { } denied)
        {
            return denied;
        }

        var ids = request.DocIds.Distinct().Take(MaxCards).ToList();
        var visible = await DocAccess.VisibleAsync(db, currentUser.Id!.Value, ids, ct);
        var docs = await db.Docs.AsNoTracking()
            .Where(d => visible.Contains(d.Id) && d.DeletedAt == null)
            .Select(d => new BoardDocCardResponse(
                d.Id, d.OrganizationId, d.Folder, d.Title, d.Kind, d.Icon, d.Color, d.UpdatedAt,
                DocKinds.HasCards(d.Kind) ? "" : d.Content.Substring(0, ExcerptLength)))
            .ToListAsync(ct);
        return TypedResults.Ok(docs);
    }

    /// <summary>Null when <paramref name="boardId"/> is a board the caller has <paramref name="permission"/> on; otherwise the answer to give.</summary>
    internal static async Task<IResult?> BoardAsync(Guid boardId, Permission permission, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (!await db.Docs.AsNoTracking().AnyAsync(d => d.Id == boardId && d.DeletedAt == null && d.Kind == DocKinds.Board, ct))
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckDocAsync(boardId, permission, ct);
        return check.IsAllowed ? null : check.Denied!;
    }
}
