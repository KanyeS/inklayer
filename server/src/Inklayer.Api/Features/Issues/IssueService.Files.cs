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
    /// <summary>
    /// A comment's file, and where it's kept here (for its public address). A recording's <see cref="Poster"/> is its still,
    /// shown where the tracker can't play the video.
    /// </summary>
    private sealed record CommentFile(IssueFile File, AnnotationScreenshot? Screenshot, AnnotationMedia? Media, CommentFile? Poster = null);

    private async Task<List<CommentFile>> FilesAsync(Annotation comment, CancellationToken ct)
    {
        var files = new List<CommentFile>();
        if (await db.AnnotationScreenshots.SingleOrDefaultAsync(s => s.AnnotationId == comment.Id, ct) is { } screenshot)
        {
            files.Add(new CommentFile(
                new IssueFile("Screenshot", $"screenshot.{PublicMediaEndpoints.Extension(screenshot.ContentType)}", screenshot.ContentType, screenshot.Bytes), screenshot, null));
        }

        var stored = await db.AnnotationMedia.Where(m => m.AnnotationId == comment.Id).OrderBy(m => m.Kind).ToListAsync(ct);
        CommentFile? poster = null;
        if (stored.Find(m => m.Kind == MediaKinds.Thumbnail) is { } still && await MediaEndpoints.ReadAllAsync(mediaStore, still, ct) is { } stillBytes)
        {
            poster = new CommentFile(new IssueFile("Recording", $"recording.{PublicMediaEndpoints.Extension(still.ContentType)}", still.ContentType, stillBytes), null, still);
        }

        foreach (var media in stored.Where(m => m.Kind != MediaKinds.Thumbnail))
        {
            if (await MediaEndpoints.ReadAllAsync(mediaStore, media, ct) is not { } bytes)
            {
                continue;
            }

            var (label, name) = media.Kind == MediaKinds.Video ? ("Recording", "recording") : ("Full page", "full-page");
            files.Add(new CommentFile(
                new IssueFile(label, $"{name}.{PublicMediaEndpoints.Extension(media.ContentType)}", media.ContentType, bytes), null, media,
                media.Kind == MediaKinds.Video ? poster : null));
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
            // A recording where the tracker can't play it (all but GitLab): its still, opening where it plays.
            if (file.Poster is { } poster && connection.Kind != TrackerKinds.GitLab)
            {
                lines.AddRange(await RecordingLinesAsync(connection, tracker, settings, token, comment, file, poster, later, ct));
                continue;
            }

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

    /// <summary>
    /// A recording shown by its still, which opens where it plays: Inklayer's page for the comment (people sign in to it),
    /// or on GitHub, the recording's public address. The video itself still goes to the tracker where it takes files.
    /// </summary>
    private async Task<List<string>> RecordingLinesAsync(
        IssueTrackerConnection connection, IIssueTracker tracker, TrackerSettings settings, TrackerToken token, Annotation comment,
        CommentFile video, CommentFile poster, List<IssueFile> later, CancellationToken ct)
    {
        var lines = new List<string> { $"**{video.File.Label}:**" };
        var play = connection.Kind == TrackerKinds.GitHub
            ? await PublicUrlAsync(video, ct)
            : Origin() is { Length: > 0 } origin ? $"{origin}/comments/{comment.Id}" : null;

        if (tracker is IIssueFiles { Upfront: true } uploads)
        {
            string? still = null, file = null;
            try
            {
                still = await accounts.WithAsync(token, t => uploads.UploadAsync(settings, t, null, poster.File, ct), ct);
                file = await accounts.WithAsync(token, t => uploads.UploadAsync(settings, t, null, video.File, ct), ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException)
            {
                connection.LastError = Clip($"Uploading the recording: {ex.Message}");
                connection.LastErrorAt = clock.GetUtcNow().UtcDateTime;
            }

            still ??= await PublicUrlAsync(poster, ct) is { } stillUrl ? poster.File.Markdown(stillUrl) : null;
            AddPlayable(lines, still, play);
            if (file is not null)
            {
                lines.Add(file.Replace($"[{video.File.Label}]", "[Download the recording]", StringComparison.Ordinal));
            }

            return lines;
        }

        if (tracker is IIssueFiles { Upfront: false })
        {
            // Jira and Forgejo: the video and its still attached; the still shown from here, opening where it plays.
            later.Add(video.File);
            lines[0] = $"**{video.File.Label}:** attached ({video.File.FileName})";
            if (connection.Kind == TrackerKinds.Jira)
            {
                if (play is not null)
                {
                    lines.Add($"Play it here: {play}");
                }

                return lines;
            }
        }

        AddPlayable(lines, await PublicUrlAsync(poster, ct) is { } url ? poster.File.Markdown(url) : null, play);
        return lines;
    }

    /// <summary>
    /// The still, linked to where the recording plays, and a link saying so: some trackers (Azure DevOps) open a picture
    /// in their own viewer when it's clicked, whatever it links to. Or just the link, without a still.
    /// </summary>
    private static void AddPlayable(List<string> lines, string? still, string? play)
    {
        if (still is not null && play is not null)
        {
            lines.Add($"[{still}]({play})");
            lines.Add($"[▶ Play the recording]({play})");
        }
        else if (play is not null)
        {
            lines.Add($"[Play the recording]({play})");
        }
        else if (still is not null)
        {
            lines.Add(still);
        }
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
