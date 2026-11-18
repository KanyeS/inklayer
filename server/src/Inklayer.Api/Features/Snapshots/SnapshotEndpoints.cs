using System.Text;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Authorization;
using Inklayer.Domain.Snapshots;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Infrastructure.Snapshots;
using Inklayer.Infrastructure.Storage;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Snapshots;

/// <summary>
/// Capture API used by the browser extension. Uploading takes three steps:
/// <list type="number">
/// <item><c>POST blobs/missing</c>: asks which content hashes the organisation doesn't have yet.</item>
/// <item><c>PUT blobs/{hash}</c>: uploads each missing blob (document HTML, assets, screenshot). The server checks every hash.</item>
/// <item><c>POST snapshots</c>: creates the snapshot from blobs that are already uploaded. The server sanitizes the HTML at this point.</item>
/// </list>
/// Large captures are therefore uploaded file by file, and anything the organisation already has is skipped.
/// </summary>
internal static class SnapshotEndpoints
{
    public static IEndpointRouteBuilder MapSnapshotEndpoints(this IEndpointRouteBuilder app)
    {
        var byProject = app.MapGroup("/api/projects/{projectId:guid}").WithTags("Snapshots").RequireAuthorization();
        byProject.MapPost("/blobs/missing", MissingBlobsAsync).WithSummary("Which of these SHA-256 hashes still need uploading");
        byProject.MapPut("/blobs/{hash}", UploadBlobAsync).WithSummary("Upload one blob; the body's SHA-256 must equal {hash}");
        byProject.MapPost("/snapshots", CreateAsync).WithSummary("Create a snapshot from uploaded blobs");
        byProject.MapGet("/snapshots", ListAsync).WithSummary("Snapshots in a project, newest first. Page with ?before=<capturedAt>.");

        var snapshots = app.MapGroup("/api/snapshots").WithTags("Snapshots").RequireAuthorization();
        snapshots.MapGet("/{snapshotId:guid}", GetAsync).WithName("GetSnapshot")
            .WithSummary("Snapshot details, with a fresh signed viewUrl on the snapshot origin");
        snapshots.MapGet("/{snapshotId:guid}/screenshot", ScreenshotAsync);
        snapshots.MapDelete("/{snapshotId:guid}", DeleteAsync).WithSummary("Delete a snapshot (its capturer, or a project Admin)");

        return app;
    }

    private static async Task<IResult> MissingBlobsAsync(Guid projectId, MissingBlobsRequest request, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Capture, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var hashes = request.Hashes.Select(h => h.ToLowerInvariant()).Distinct(StringComparer.Ordinal).ToList();
        if (hashes.Exists(h => !BlobStore.IsValidHash(h)))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["hashes"] = ["Each hash must be 64 lower-case hex characters (SHA-256)."] });
        }

        var present = new HashSet<string>(StringComparer.Ordinal);
        foreach (var batch in hashes.Chunk(500))
        {
            present.UnionWith(await db.OrganizationBlobs
                .Where(b => b.OrganizationId == check.OrganizationId && batch.Contains(b.Hash))
                .Select(b => b.Hash)
                .ToListAsync(ct));
        }

        return TypedResults.Ok(new MissingBlobsResponse([.. hashes.Where(h => !present.Contains(h))]));
    }

    private static async Task<IResult> UploadBlobAsync(
        Guid projectId, string hash, HttpContext context, AccessService access, InklayerDbContext db, BlobStore blobs,
        IOptions<SnapshotOptions> options, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Capture, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        if (!BlobStore.IsValidHash(hash))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["hash"] = ["Must be 64 lower-case hex characters (SHA-256)."] });
        }

        if (await db.OrganizationBlobs.AnyAsync(b => b.OrganizationId == check.OrganizationId && b.Hash == hash, ct))
        {
            return TypedResults.Ok();
        }

        var maxBytes = options.Value.MaxBlobBytes;
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
        {
            limit.MaxRequestBodySize = maxBytes;
        }

        // Always read the body, even if another organisation already stored this blob: uploading proves you have the content.
        var result = await blobs.WriteAsync(hash, context.Request.Body, maxBytes, ct);
        switch (result)
        {
            case BlobWriteResult.HashMismatch:
                return TypedResults.Problem(statusCode: StatusCodes.Status400BadRequest, title: "The uploaded content does not match the hash.");
            case BlobWriteResult.TooLarge:
                return TypedResults.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: $"Blobs are limited to {maxBytes / (1024 * 1024)} MB.");
        }

        db.OrganizationBlobs.Add(new OrganizationBlob
        {
            OrganizationId = check.OrganizationId,
            Hash = hash,
            Size = blobs.GetSize(hash) ?? 0,
            CreatedAt = clock.GetUtcNow().UtcDateTime,
        });

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException)
        {
            // The same blob was uploaded twice at once for this organisation; the first upload already recorded it.
        }

        return TypedResults.Created();
    }

    private static async Task<IResult> CreateAsync(
        Guid projectId, CreateSnapshotRequest request, AccessService access, CurrentUser currentUser, InklayerDbContext db,
        BlobStore blobs, IOptions<SnapshotOptions> options, SnapshotLinks links, TimeProvider clock, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.Capture, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var errors = new Dictionary<string, string[]>();
        if (!Uri.TryCreate(request.Url, UriKind.Absolute, out var pageUrl) || (pageUrl.Scheme != Uri.UriSchemeHttp && pageUrl.Scheme != Uri.UriSchemeHttps))
        {
            errors["url"] = ["Must be an absolute http(s) URL."];
        }

        if (request.Assets.Count > options.Value.MaxAssetsPerSnapshot)
        {
            errors["assets"] = [$"At most {options.Value.MaxAssetsPerSnapshot} assets per snapshot."];
        }

        var documentHash = request.DocumentHash.ToLowerInvariant();
        var screenshotHash = request.ScreenshotHash?.ToLowerInvariant();
        var assets = request.Assets
            .GroupBy(a => a.Hash.ToLowerInvariant(), StringComparer.Ordinal)
            .Select(g => (Hash: g.Key, ContentType: SnapshotContentTypes.Normalize(g.First().ContentType)))
            .ToList();
        var allHashes = assets.Select(a => a.Hash).Append(documentHash).Concat(screenshotHash is null ? [] : [screenshotHash]).Distinct(StringComparer.Ordinal).ToList();
        if (allHashes.Exists(h => !BlobStore.IsValidHash(h)))
        {
            errors["hashes"] = ["Each hash must be 64 lower-case hex characters (SHA-256)."];
        }

        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        var owned = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var batch in allHashes.Chunk(500))
        {
            foreach (var blob in await db.OrganizationBlobs
                .Where(b => b.OrganizationId == check.OrganizationId && batch.Contains(b.Hash))
                .Select(b => new { b.Hash, b.Size })
                .ToListAsync(ct))
            {
                owned[blob.Hash] = blob.Size;
            }
        }

        var missing = allHashes.Where(h => !owned.ContainsKey(h) || !blobs.Exists(h)).ToList();
        if (missing.Count > 0)
        {
            return TypedResults.Problem(
                statusCode: StatusCodes.Status409Conflict,
                title: "Some blobs have not been uploaded.",
                extensions: new Dictionary<string, object?> { ["missing"] = missing });
        }

        if (owned[documentHash] > options.Value.MaxDocumentBytes)
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status413PayloadTooLarge, title: "The page's HTML is too large.");
        }

        string? screenshotType = null;
        if (screenshotHash is not null)
        {
            screenshotType = await SnapshotContentTypes.DetectScreenshotAsync(blobs, screenshotHash, ct);
            if (screenshotType is null)
            {
                return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["screenshotHash"] = ["The screenshot must be a PNG, JPEG or WebP image."] });
            }
        }

        // Sanitize the HTML and store the result as a new blob. The client's original upload is never served.
        string rawHtml;
        await using (var stream = blobs.OpenRead(documentHash)!)
        using (var reader = new StreamReader(stream, Encoding.UTF8))
        {
            rawHtml = await reader.ReadToEndAsync(ct);
        }

        var sanitized = Encoding.UTF8.GetBytes(SnapshotSanitizer.Sanitize(rawHtml));
        var sanitizedHash = await blobs.WriteAsync(sanitized, ct);
        var now = clock.GetUtcNow().UtcDateTime;
        if (!owned.ContainsKey(sanitizedHash) && !await db.OrganizationBlobs.AnyAsync(b => b.OrganizationId == check.OrganizationId && b.Hash == sanitizedHash, ct))
        {
            db.OrganizationBlobs.Add(new OrganizationBlob { OrganizationId = check.OrganizationId, Hash = sanitizedHash, Size = sanitized.Length, CreatedAt = now });
        }

        var title = (request.Title ?? "").Trim();
        var snapshot = new Snapshot
        {
            ProjectId = projectId,
            OrganizationId = check.OrganizationId,
            Url = pageUrl!.ToString(),
            Title = title.Length > 500 ? title[..500] : title,
            ViewportWidth = request.ViewportWidth,
            ViewportHeight = request.ViewportHeight,
            DevicePixelRatio = request.DevicePixelRatio,
            ScrollX = Math.Max(0, request.ScrollX),
            ScrollY = Math.Max(0, request.ScrollY),
            UserAgent = request.UserAgent,
            DocumentHash = sanitizedHash,
            ScreenshotHash = screenshotHash,
            ScreenshotContentType = screenshotType,
            TotalBytes = sanitized.Length + (screenshotHash is null ? 0 : owned[screenshotHash]) + assets.Sum(a => owned[a.Hash]),
            CapturedByUserId = currentUser.Id!.Value,
            CapturedAt = now,
        };
        snapshot.Assets.AddRange(assets.Select(a => new SnapshotAsset { SnapshotId = snapshot.Id, Hash = a.Hash, ContentType = a.ContentType, Size = owned[a.Hash] }));

        db.Snapshots.Add(snapshot);
        await db.SaveChangesAsync(ct);

        var user = (await currentUser.GetAsync(ct))!;
        return TypedResults.CreatedAtRoute(ToResponse(snapshot, new UserSummary(user.Id, user.DisplayName), links), "GetSnapshot", new { snapshotId = snapshot.Id });
    }

    private static async Task<IResult> ListAsync(Guid projectId, DateTime? before, int? limit, AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        var check = await access.CheckProjectAsync(projectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var query = db.Snapshots.AsNoTracking().Where(s => s.ProjectId == projectId);
        if (before is { } cursor)
        {
            var utc = cursor.Kind == DateTimeKind.Utc ? cursor : cursor.ToUniversalTime();
            query = query.Where(s => s.CapturedAt < utc);
        }

        var items = await query
            .OrderByDescending(s => s.CapturedAt).ThenByDescending(s => s.Id)
            .Take(Math.Clamp(limit ?? 50, 1, 200))
            .Select(s => new SnapshotSummary(
                s.Id, s.ProjectId, s.Url, s.Title, s.CapturedAt,
                new UserSummary(s.CapturedByUserId, db.Users.Where(u => u.Id == s.CapturedByUserId).Select(u => u.DisplayName).FirstOrDefault() ?? ""),
                s.ViewportWidth, s.ViewportHeight, s.ScreenshotHash != null, s.Assets.Count, s.TotalBytes))
            .ToListAsync(ct);

        return TypedResults.Ok(items);
    }

    private static async Task<IResult> GetAsync(Guid snapshotId, AccessService access, InklayerDbContext db, SnapshotLinks links, CancellationToken ct)
    {
        var snapshot = await db.Snapshots.AsNoTracking().Include(s => s.Assets).SingleOrDefaultAsync(s => s.Id == snapshotId, ct);
        if (snapshot is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(snapshot.ProjectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var capturer = await db.Users.Where(u => u.Id == snapshot.CapturedByUserId).Select(u => new UserSummary(u.Id, u.DisplayName)).SingleOrDefaultAsync(ct);
        return TypedResults.Ok(ToResponse(snapshot, capturer ?? new UserSummary(snapshot.CapturedByUserId, ""), links));
    }

    private static async Task<IResult> ScreenshotAsync(Guid snapshotId, HttpContext context, AccessService access, InklayerDbContext db, BlobStore blobs, CancellationToken ct)
    {
        var snapshot = await db.Snapshots.AsNoTracking().SingleOrDefaultAsync(s => s.Id == snapshotId, ct);
        if (snapshot?.ScreenshotHash is null)
        {
            return TypedResults.NotFound();
        }

        var check = await access.CheckProjectAsync(snapshot.ProjectId, Permission.View, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        var stream = blobs.OpenRead(snapshot.ScreenshotHash);
        if (stream is null)
        {
            return TypedResults.NotFound();
        }

        context.Response.Headers.CacheControl = "private, max-age=86400, immutable";
        context.Response.Headers.ContentSecurityPolicy = "default-src 'none'; sandbox";
        context.Response.Headers.XContentTypeOptions = "nosniff";
        return TypedResults.Stream(stream, snapshot.ScreenshotContentType);
    }

    private static async Task<IResult> DeleteAsync(Guid snapshotId, AccessService access, CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct)
    {
        var snapshot = await db.Snapshots.SingleOrDefaultAsync(s => s.Id == snapshotId, ct);
        if (snapshot is null)
        {
            return TypedResults.NotFound();
        }

        var isCapturer = snapshot.CapturedByUserId == currentUser.Id;
        var check = await access.CheckProjectAsync(snapshot.ProjectId, isCapturer ? Permission.Capture : Permission.ManageProjects, ct);
        if (!check.IsAllowed)
        {
            return check.Denied!;
        }

        db.Snapshots.Remove(snapshot);
        audit.Record(AuditActions.SnapshotDeleted, snapshot.OrganizationId, "snapshot", snapshotId, new { snapshot.Url, snapshot.ProjectId });
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static SnapshotResponse ToResponse(Snapshot s, UserSummary capturer, SnapshotLinks links) => new(
        s.Id, s.ProjectId, s.OrganizationId, s.Url, s.Title, s.CapturedAt, capturer,
        s.ViewportWidth, s.ViewportHeight, s.DevicePixelRatio, s.ScrollX, s.ScrollY, s.UserAgent,
        s.Assets.Count, s.TotalBytes, links.CreateViewUrl(s.Id), s.ScreenshotHash is null ? null : $"/api/snapshots/{s.Id}/screenshot");
}
