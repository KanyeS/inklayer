using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Features;

/// <summary>
/// Full-page screenshots kept with a comment, and a comment's files in the issue made from it: uploaded to trackers that take
/// files (GitLab, Azure DevOps, Linear upfront; Jira, Forgejo attached after), shown from Inklayer's public address on GitHub.
/// </summary>
public sealed partial class IssueTrackerTests
{
    private static byte[] FullPagePng => [.. Png, .. Enumerable.Range(0, 5000).Select(i => (byte)(i % 251))];

    private static async Task PutImageAsync(HttpClient client, string path, byte[] bytes, string type = "image/png")
    {
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(type);
        await client.PutAsync(new Uri(path, UriKind.Relative), content).ExpectAsync(HttpStatusCode.NoContent);
    }

    [Fact]
    public async Task Full_page_screenshots_are_kept_with_the_comment_and_read_in_parts()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var comment = await CommentAsync(ana, projectId, "Footer overlaps on long pages");
        var path = $"/api/annotations/{comment}/media/fullpage";

        // Only the author adds it, and only an image.
        using (var notImage = new ByteArrayContent("<html>"u8.ToArray()))
        {
            notImage.Headers.ContentType = new MediaTypeHeaderValue("text/html");
            await ana.PutAsync(new Uri(path, UriKind.Relative), notImage).ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        }

        using (var fake = new ByteArrayContent("not a png at all"u8.ToArray()))
        {
            fake.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            await ana.PutAsync(new Uri(path, UriKind.Relative), fake).ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        }

        using (var byAdmin = new ByteArrayContent(FullPagePng))
        {
            byAdmin.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            await admin.PutAsync(new Uri(path, UriKind.Relative), byAdmin).ExpectAsync(HttpStatusCode.Forbidden);
        }

        await PutImageAsync(ana, $"{path}?width=1200&height=9000", FullPagePng);

        // Anyone who can see the comment reads it, whole or in parts; the comment says it has one.
        using (var whole = await viewer.GetAsync(new Uri(path, UriKind.Relative)))
        {
            Assert.Equal(HttpStatusCode.OK, whole.StatusCode);
            Assert.Equal(FullPagePng, await whole.Content.ReadAsByteArrayAsync());
            Assert.Equal("image/png", whole.Content.Headers.ContentType!.MediaType);
        }

        using (var request = new HttpRequestMessage(HttpMethod.Get, path))
        {
            request.Headers.Range = new RangeHeaderValue(10, 19);
            using var part = await viewer.SendAsync(request);
            Assert.Equal(HttpStatusCode.PartialContent, part.StatusCode);
            Assert.Equal(FullPagePng[10..20], await part.Content.ReadAsByteArrayAsync());
            Assert.Equal($"bytes 10-19/{FullPagePng.Length}", part.Content.Headers.ContentRange!.ToString());
        }

        var media = Assert.Single((await CommentJsonAsync(viewer, comment)).GetProperty("media").EnumerateArray());
        Assert.Equal(("fullpage", 1200, 9000), (media.GetProperty("kind").GetString(), media.GetProperty("width").GetInt32(), media.GetProperty("height").GetInt32()));

        // Taken again: the new one replaces it.
        var second = FullPagePng.Reverse().ToArray();
        second[0..8].AsSpan().Clear();
        Png[..8].CopyTo(second, 0);
        await PutImageAsync(ana, path, second);
        using (var again = await viewer.GetAsync(new Uri(path, UriKind.Relative)))
        {
            Assert.Equal(second, await again.Content.ReadAsByteArrayAsync());
        }
    }

    /// <summary>A tracker's fake API for issues with files; returns the tracker's settings.</summary>
    private object InstallFileTracker(string kind)
    {
        var r = factory.Outbound.Responders;
        switch (kind)
        {
            case "gitlab":
            {
                const string Project = "https://gitlab.com/api/v4/projects/acme%2Ffiles";
                var n = 0;
                r[Project] = (_, _) => Json(new { issues_enabled = true });
                r[$"{Project}/uploads"] = (_, _) => Json(new { url = $"/uploads/hash{Interlocked.Increment(ref n)}/file.png", markdown = "x" }, HttpStatusCode.Created);
                r[$"{Project}/issues"] = (_, _) => Json(new { iid = 9, web_url = "https://gitlab.com/acme/files/-/issues/9" }, HttpStatusCode.Created);
                return new { projectKey = "acme/files" };
            }

            case "azuredevops":
            {
                const string Project = "https://dev.azure.com/files/Shop";
                var n = 0;
                r[$"{Project}/_apis/wit/workitemtypes/Bug"] = (_, _) => Json(new { name = "Bug" });
                r[$"{Project}/_apis/wit/attachments"] = (_, _) => Json(new { id = "a", url = $"https://dev.azure.com/files/_apis/wit/attachments/att-{Interlocked.Increment(ref n)}" });
                r[$"{Project}/_apis/wit/workitems/$Bug"] = (_, _) => Json(new { id = 9 });
                return new { site = "https://dev.azure.com/files", projectKey = "Shop" };
            }

            case "linear":
            {
                var n = 0;
                r["https://api.linear.app/graphql"] = (_, body) => body.Contains("fileUpload", StringComparison.Ordinal)
                    ? Json(new
                    {
                        data = new
                        {
                            fileUpload = new
                            {
                                success = true,
                                uploadFile = new
                                {
                                    uploadUrl = $"https://uploads.linear-test.example/put/{Interlocked.Increment(ref n)}", assetUrl = $"https://uploads.linear-test.example/asset/{n}",
                                    headers = new[] { new { key = "x-goog-meta-test", value = "1" } },
                                },
                            },
                        },
                    })
                    : body.Contains("issueCreate", StringComparison.Ordinal)
                        ? Json(new { data = new { issueCreate = new { success = true, issue = new { id = "i-9", identifier = "ENG-9", url = "https://linear.app/acme/issue/ENG-9" } } } })
                        : Json(new { data = new { team = new { id = "team-files", name = "Eng" } } });
                r["https://uploads.linear-test.example/put/"] = (_, _) => new HttpResponseMessage(HttpStatusCode.OK);
                return new { teamId = "team-files" };
            }

            case "jira":
            {
                const string Site = "https://files.atlassian.net";
                r[$"{Site}/rest/api/3/project/WEB"] = (_, _) => Json(new { key = "WEB" });
                r[$"{Site}/rest/api/3/issue"] = (_, _) => Json(new { key = "WEB-9" }, HttpStatusCode.Created);
                r[$"{Site}/rest/api/3/issue/WEB-9/attachments"] = (_, _) => Json(new[] { new { id = "1" } });
                return new { site = Site, projectKey = "WEB", email = "bot@acme.test" };
            }

            case "forgejo":
            {
                const string Repo = "https://codeberg.org/api/v1/repos/acme/files";
                r[Repo] = (_, _) => Json(new { has_issues = true });
                r[$"{Repo}/issues"] = (_, _) => Json(new { number = 9, html_url = "https://codeberg.org/acme/files/issues/9" }, HttpStatusCode.Created);
                r[$"{Repo}/issues/9/assets"] = (_, _) => Json(new { browser_download_url = "https://codeberg.org/attachments/x" }, HttpStatusCode.Created);
                return new { owner = "acme", repo = "files" };
            }

            default:
            {
                const string Repo = "https://api.github.com/repos/acme/files";
                r[Repo] = (_, _) => Json(new { has_issues = true, permissions = new { push = true } });
                r[$"{Repo}/issues"] = (_, _) => Json(new { number = 9, html_url = "https://github.com/acme/files/issues/9" }, HttpStatusCode.Created);
                return new { owner = "acme", repo = "files" };
            }
        }
    }

    [Theory]
    [InlineData("gitlab")]
    [InlineData("azuredevops")]
    [InlineData("linear")]
    [InlineData("jira")]
    [InlineData("forgejo")]
    [InlineData("github")]
    public async Task A_comments_screenshots_go_into_its_issue_kept_by_the_tracker_where_it_takes_files(string kind)
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind, token = "shared", settings = InstallFileTracker(kind) });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var comment = await CommentAsync(ana, projectId, "Footer overlaps");
        await PutImageAsync(ana, $"/api/annotations/{comment}/screenshot?width=800&height=400", Png);
        await PutImageAsync(ana, $"/api/annotations/{comment}/media/fullpage?width=1200&height=9000", FullPagePng);
        var before = factory.Outbound.Requests.Count;
        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        var sent = factory.Outbound.Requests.Skip(before).ToList();
        string Sent(string urlPart, HttpMethod method) => Assert.Single(sent, x => x.Request.RequestUri!.AbsolutePath.EndsWith(urlPart, StringComparison.Ordinal) && x.Request.Method == method).Body;
        int Count(string urlPart) => sent.Count(x => x.Request.RequestUri!.ToString().Contains(urlPart, StringComparison.Ordinal) && x.Request.Method != HttpMethod.Get);

        switch (kind)
        {
            case "gitlab":
            {
                Assert.Equal(2, Count("/projects/acme%2Ffiles/uploads"));
                var body = JsonDocument.Parse(Sent("/projects/acme%2Ffiles/issues", HttpMethod.Post)).RootElement.GetProperty("description").GetString()!;
                Assert.Contains("![Screenshot](/uploads/hash1/file.png)", body, StringComparison.Ordinal);
                Assert.Contains("![Full page](/uploads/hash2/file.png)", body, StringComparison.Ordinal);
                break;
            }

            case "azuredevops":
            {
                Assert.Equal(2, Count("/_apis/wit/attachments"));
                var ops = JsonDocument.Parse(Sent("/_apis/wit/workitems/$Bug", HttpMethod.Post)).RootElement.EnumerateArray().ToList();
                var html = ops.Single(o => o.GetProperty("path").GetString() == "/fields/Microsoft.VSTS.TCM.ReproSteps").GetProperty("value").GetString()!;
                Assert.Contains("<img src=\"https://dev.azure.com/files/_apis/wit/attachments/att-1\"", html, StringComparison.Ordinal);
                Assert.Contains("<img src=\"https://dev.azure.com/files/_apis/wit/attachments/att-2\"", html, StringComparison.Ordinal);
                Assert.Equal(2, ops.Count(o => o.GetProperty("path").GetString() == "/relations/-" && o.GetProperty("value").GetProperty("rel").GetString() == "AttachedFile"));
                break;
            }

            case "linear":
            {
                var puts = sent.Where(x => x.Request.RequestUri!.ToString().StartsWith("https://uploads.linear-test.example/put/", StringComparison.Ordinal)).ToList();
                Assert.Equal(2, puts.Count);
                Assert.All(puts, p => Assert.Null(p.Request.Headers.Authorization));
                Assert.All(puts, p => Assert.Equal("1", p.Request.Headers.GetValues("x-goog-meta-test").Single()));
                var create = sent.Single(x => x.Body.Contains("issueCreate", StringComparison.Ordinal)).Body;
                Assert.Contains("![Screenshot](https://uploads.linear-test.example/asset/1)", JsonDocument.Parse(create).RootElement.GetProperty("variables").GetProperty("input").GetProperty("description").GetString()!, StringComparison.Ordinal);
                break;
            }

            case "jira":
            {
                var attachments = sent.Where(x => x.Request.RequestUri!.ToString().EndsWith("/issue/WEB-9/attachments", StringComparison.Ordinal)).ToList();
                Assert.Equal(2, attachments.Count);
                Assert.All(attachments, a => Assert.Equal("no-check", a.Request.Headers.GetValues("X-Atlassian-Token").Single()));
                var description = Sent("/rest/api/3/issue", HttpMethod.Post);
                Assert.Contains("{\"type\":\"text\",\"text\":\"Screenshot:\",\"marks\":[{\"type\":\"strong\"}]}", description, StringComparison.Ordinal);
                Assert.Contains("attached (screenshot.png)", description, StringComparison.Ordinal);
                break;
            }

            case "forgejo":
                Assert.Equal(2, Count("/issues/9/assets"));
                Assert.Contains("attached (full-page.png)", JsonDocument.Parse(Sent("/repos/acme/files/issues", HttpMethod.Post)).RootElement.GetProperty("body").GetString()!, StringComparison.Ordinal);
                break;

            default:
            {
                // GitHub can't take files: shown from Inklayer's public address, which anyone (GitHub's image proxy) can fetch.
                var body = JsonDocument.Parse(Sent("/repos/acme/files/issues", HttpMethod.Post)).RootElement.GetProperty("body").GetString()!;
                var fullPage = Regex.Match(body, @"!\[Full page\]\(http://localhost(/media/[A-Za-z0-9_-]{43}\.png)\)");
                Assert.True(fullPage.Success, body);
                Assert.Matches(@"!\[Screenshot\]\(http://localhost/media/[A-Za-z0-9_-]{43}\.png\)", body);
                using var anyone = factory.CreateClient();
                using var fetched = await anyone.GetAsync(new Uri(fullPage.Groups[1].Value, UriKind.Relative));
                Assert.Equal(FullPagePng, await fetched.Content.ReadAsByteArrayAsync());
                break;
            }
        }
    }

    [Fact]
    public async Task A_failed_upload_falls_back_to_the_public_address_and_the_issue_is_still_made()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        const string Project = "https://gitlab.com/api/v4/projects/acme%2Fnoupload";
        factory.Outbound.Responders[Project] = (_, _) => Json(new { issues_enabled = true });
        factory.Outbound.Responders[$"{Project}/uploads"] = (_, _) => Json(new { message = "413 Request Entity Too Large" }, HttpStatusCode.RequestEntityTooLarge);
        factory.Outbound.Responders[$"{Project}/issues"] = (_, _) => Json(new { iid = 3, web_url = "https://gitlab.com/acme/noupload/-/issues/3" }, HttpStatusCode.Created);
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "gitlab", token = "glpat", settings = new { projectKey = "acme/noupload" } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var comment = await CommentAsync(ana, projectId, "Logo blurry");
        await PutImageAsync(ana, $"/api/annotations/{comment}/screenshot", Png);

        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        var body = JsonDocument.Parse(factory.Outbound.To($"{Project}/issues").Single(x => x.Request.Method == HttpMethod.Post).Body).RootElement.GetProperty("description").GetString()!;
        Assert.Matches(@"!\[Screenshot\]\(http://localhost/media/", body);
        using var list = await admin.GetAsync(new Uri($"/api/projects/{projectId}/issue-trackers", UriKind.Relative));
        Assert.Contains("Uploading the screenshot", await list.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Recordings_are_kept_played_in_parts_and_linked_from_issues()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        var comment = await CommentAsync(ana, projectId, "Menu jumps when scrolling");
        var path = $"/api/annotations/{comment}/media/video";
        byte[] webm = [0x1A, 0x45, 0xDF, 0xA3, .. Enumerable.Range(0, 100_000).Select(i => (byte)(i % 253))];

        // A WebM or MP4 that is one; images and look-alikes aren't.
        await PutImageAsync(ana, path, webm, "video/webm");
        using (var png = new ByteArrayContent(Png))
        {
            png.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            await ana.PutAsync(new Uri(path, UriKind.Relative), png).ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        }

        using (var notMp4 = new ByteArrayContent(webm))
        {
            notMp4.Headers.ContentType = new MediaTypeHeaderValue("video/mp4");
            await ana.PutAsync(new Uri(path, UriKind.Relative), notMp4).ExpectAsync(HttpStatusCode.UnsupportedMediaType);
        }

        // Played in parts, as video players ask.
        using (var request = new HttpRequestMessage(HttpMethod.Get, path))
        {
            request.Headers.Range = new RangeHeaderValue(50_000, null);
            using var part = await viewer.SendAsync(request);
            Assert.Equal(HttpStatusCode.PartialContent, part.StatusCode);
            Assert.Equal(webm[50_000..], await part.Content.ReadAsByteArrayAsync());
            Assert.Equal("video/webm", part.Content.Headers.ContentType!.MediaType);
        }

        using (var request = new HttpRequestMessage(HttpMethod.Get, path))
        {
            request.Headers.Range = new RangeHeaderValue(200_000, null);
            using var past = await viewer.SendAsync(request);
            Assert.Equal(HttpStatusCode.RequestedRangeNotSatisfiable, past.StatusCode);
        }

        // Its still, with a play symbol, for issues where it can't play.
        await PutImageAsync(ana, $"/api/annotations/{comment}/media/thumbnail", Png);

        // In a GitHub issue: the still, opening Inklayer's copy, which plays from the public address.
        const string Repo = "https://api.github.com/repos/acme/recordings";
        factory.Outbound.Responders[Repo] = (_, _) => Json(new { has_issues = true, permissions = new { push = true } });
        factory.Outbound.Responders[$"{Repo}/issues"] = (_, _) => Json(new { number = 2, html_url = "https://github.com/acme/recordings/issues/2" }, HttpStatusCode.Created);
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "github", token = "ghp", settings = new { owner = "acme", repo = "recordings" } });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        var body = JsonDocument.Parse(factory.Outbound.To($"{Repo}/issues").Single(x => x.Request.Method == HttpMethod.Post).Body).RootElement.GetProperty("body").GetString()!;
        var link = Regex.Match(body, @"\[!\[Recording\]\(http://localhost/media/[A-Za-z0-9_-]{43}\.png\)\]\(http://localhost(/media/[A-Za-z0-9_-]{43}\.webm)\)");
        Assert.True(link.Success, body);
        using var anyone = factory.CreateClient();
        using var played = await anyone.GetAsync(new Uri(link.Groups[1].Value, UriKind.Relative));
        Assert.Equal(webm, await played.Content.ReadAsByteArrayAsync());
    }

    [Fact]
    public async Task Where_a_recording_cant_play_its_still_opens_the_comment_in_Inklayer_and_the_video_is_attached()
    {
        var (admin, projectId, ana, _, viewer) = await ProjectAsync();
        using var _a = admin;
        using var _b = ana;
        using var _c = viewer;
        using var connected = await admin.PostJsonAsync($"/api/projects/{projectId}/issue-trackers", new { kind = "azuredevops", token = "pat", settings = InstallFileTracker("azuredevops") });
        var tracker = await connected.ReadAsync<TrackerDto>(HttpStatusCode.Created);
        var comment = await CommentAsync(ana, projectId, "Dropdown flickers");
        await PutImageAsync(ana, $"/api/annotations/{comment}/media/video", [0x1A, 0x45, 0xDF, 0xA3, 1, 2, 3, 4], "video/webm");
        await PutImageAsync(ana, $"/api/annotations/{comment}/media/thumbnail", Png);
        var before = factory.Outbound.Requests.Count;

        await ana.PostJsonAsync($"/api/annotations/{comment}/issues", new { connectionId = tracker.Id }).ExpectAsync(HttpStatusCode.Created);
        var sent = factory.Outbound.Requests.Skip(before).ToList();
        var uploads = sent.Where(x => x.Request.RequestUri!.AbsolutePath.EndsWith("/_apis/wit/attachments", StringComparison.Ordinal)).ToList();
        Assert.Equal(["recording.png", "recording.webm"], uploads.Select(u => System.Web.HttpUtility.ParseQueryString(u.Request.RequestUri!.Query)["fileName"]));
        var ops = JsonDocument.Parse(sent.Single(x => x.Request.RequestUri!.AbsolutePath.EndsWith("/workitems/$Bug", StringComparison.Ordinal)).Body).RootElement.EnumerateArray().ToList();
        var html = ops.Single(o => o.GetProperty("path").GetString() == "/fields/Microsoft.VSTS.TCM.ReproSteps").GetProperty("value").GetString()!;
        Assert.Contains($"<a href=\"http://localhost/comments/{comment}\"><img src=\"https://dev.azure.com/files/_apis/wit/attachments/att-1\"", html, StringComparison.Ordinal);
        Assert.Contains("<a href=\"https://dev.azure.com/files/_apis/wit/attachments/att-2\">Download the recording</a>", html, StringComparison.Ordinal);
        Assert.Equal(2, ops.Count(o => o.GetProperty("path").GetString() == "/relations/-"));
    }
}
