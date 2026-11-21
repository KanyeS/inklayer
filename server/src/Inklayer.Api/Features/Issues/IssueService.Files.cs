using Inklayer.Api.Features.Annotations;
using Inklayer.Api.Features.Media;
using Inklayer.Domain.Annotations;
using Inklayer.Domain.Issues;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Issues;

/// <summary>
/// The files captured with a comment (its screenshot, full-page screenshot, video), put in the issue made from it: uploaded
/// to trackers that take files, so they keep and serve them; for GitHub, which can't, shown from Inklayer's public address.
/// </summary>
internal sealed partial class IssueService
{
    /// <summary>A comment's file, and where it's kept here (for its public address).</summary>
    private sealed record CommentFile(IssueFile File, AnnotationScreenshot? Screenshot, AnnotationMedia? Media);

    private async Task<List<CommentFile>> FilesAsync(Annotation comment, CancellationToken ct)
    {
        var files = new List<CommentFile>();
        if (await db.AnnotationScreenshots.SingleOrDefaultAsync(s => s.AnnotationId == comment.Id, ct) is { } screenshot)
        {
            files.Add(new CommentFile(
                new IssueFile("Screenshot", $"screenshot.{PublicMediaEndpoints.Extension(screenshot.ContentType)}", screenshot.ContentType, screenshot.Bytes), screenshot, null));
        }

        foreach (var media in await db.AnnotationMedia.Where(m => m.AnnotationId == comment.Id).OrderBy(m => m.Kind).ToListAsync(ct))
        {
            if (await MediaEndpoints.ReadAllAsync(mediaStore, media, ct) is not { } bytes)
            {
                continue;
            }

            var (label, name) = media.Kind == MediaKinds.Video ? ("Recording", "recording") : ("Full page", "full-page");
            files.Add(new CommentFile(new IssueFile(label, $"{name}.{PublicMediaEndpoints.Extension(media.ContentType)}", media.ContentType, bytes), null, media));
        }

        return files;
    }

    /// <summary>The file at Inklayer's public address (made the first time it's needed); null without an address to give.</summary>
    private async Task<string?> PublicUrlAsync(CommentFile file, CancellationToken ct)
    {
        var origin = Origin();
        if (origin.Length == 0)
        {
            return null;
        }

        string token;
        if (file.Screenshot is { } screenshot)
        {
            token = screenshot.PublicToken ??= PublicMediaEndpoints.NewToken();
        }
        else
        {
            token = file.Media!.PublicToken ??= PublicMediaEndpoints.NewToken();
        }

        await db.SaveChangesAsync(ct);
        return $"{origin}{PublicMediaEndpoints.PathPrefix}/{token}.{PublicMediaEndpoints.Extension(file.File.ContentType)}";
    }

    /// <summary>
    /// The lines that show the comment's files in an issue or note, and those to attach once it exists. Trackers that take
    /// files upfront get them uploaded now; if that fails, or the tracker takes none, they're shown from the public address.
    /// </summary>
    private async Task<(List<string> Lines, List<IssueFile> Later)> PlaceFilesAsync(
        IssueTrackerConnection connection, IIssueTracker tracker, TrackerSettings settings, TrackerToken token, Annotation comment, CancellationToken ct)
    {
        var lines = new List<string>();
        var later = new List<IssueFile>();
        foreach (var file in await FilesAsync(comment, ct))
        {
            if (tracker is IIssueFiles { Upfront: false })
            {
                lines.Add($"**{file.File.Label}:** attached ({file.File.FileName})");
                later.Add(file.File);
                continue;
            }

            string? shown = null;
            if (tracker is IIssueFiles uploads)
            {
                try
                {
                    shown = await accounts.WithAsync(token, t => uploads.UploadAsync(settings, t, null, file.File, ct), ct);
                }
                catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
                {
                    connection.LastError = Clip($"Uploading the {file.File.Label.ToLowerInvariant()}: {ex.Message}");
                    connection.LastErrorAt = clock.GetUtcNow().UtcDateTime;
                }
            }

            if (shown is null && await PublicUrlAsync(file, ct) is { } url)
            {
                shown = file.File.Markdown(url);
            }

            if (shown is not null)
            {
                lines.Add($"**{file.File.Label}:**");
                lines.Add(shown);
            }
        }

        return (lines, later);
    }

    /// <summary>Attaches files to the issue now it exists (Jira, Forgejo). Failures are noted on the connection; the issue stands.</summary>
    private async Task AttachLaterAsync(
        IssueTrackerConnection connection, IIssueTracker tracker, TrackerSettings settings, TrackerToken token, string issueExternalId, string key,
        List<IssueFile> later, CancellationToken ct)
    {
        if (later.Count == 0 || tracker is not IIssueFiles uploads)
        {
            return;
        }

        foreach (var file in later)
        {
            try
            {
                await accounts.WithAsync(token, t => uploads.UploadAsync(settings, t, issueExternalId, file, ct), ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
            {
                connection.LastError = Clip($"Attaching the {file.Label.ToLowerInvariant()} to {key}: {ex.Message}");
                connection.LastErrorAt = clock.GetUtcNow().UtcDateTime;
            }
        }

        await db.SaveChangesAsync(ct);
    }
}
