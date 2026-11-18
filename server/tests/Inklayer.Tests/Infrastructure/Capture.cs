using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

namespace Inklayer.Tests.Infrastructure;

/// <summary>Uploads a capture the same way the extension does: check what's missing, upload it, then create the snapshot.</summary>
public static class Capture
{
    // 1x1 transparent PNG.
    public static readonly byte[] Png = Convert.FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=");

    public static string Hash(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    public static async Task UploadAsync(HttpClient client, Guid projectId, byte[] bytes, string contentType, HttpStatusCode expected = HttpStatusCode.Created)
    {
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
        await client.PutAsync(new Uri($"/api/projects/{projectId}/blobs/{Hash(bytes)}", UriKind.Relative), content).ExpectAsync(expected);
    }

    /// <summary>Creates a snapshot whose page shows one image asset, with an optional screenshot.</summary>
    public static async Task<SnapshotDto> SnapshotAsync(HttpClient client, Guid projectId, string bodyHtml = "<h1>Hello</h1>", byte[]? asset = null, byte[]? screenshot = null)
    {
        asset ??= Png;
        var html = Encoding.UTF8.GetBytes($"<!DOCTYPE html><html><head><title>Test page</title></head><body>{bodyHtml}<img src=\"a/{Hash(asset)}\"></body></html>");

        var blobs = new Dictionary<string, byte[]> { [Hash(html)] = html, [Hash(asset)] = asset };
        if (screenshot is not null)
        {
            blobs[Hash(screenshot)] = screenshot;
        }

        using (var missingResponse = await client.PostJsonAsync($"/api/projects/{projectId}/blobs/missing", new { hashes = blobs.Keys }))
        {
            foreach (var hash in (await missingResponse.ReadAsync<MissingDto>()).Missing)
            {
                await UploadAsync(client, projectId, blobs[hash], hash == Hash(html) ? "text/html" : "image/png");
            }
        }

        using var response = await client.PostJsonAsync($"/api/projects/{projectId}/snapshots", new
        {
            url = "https://shop.example/products?id=1",
            title = "Test page",
            viewportWidth = 1280,
            viewportHeight = 800,
            devicePixelRatio = 2.0,
            scrollX = 0,
            scrollY = 120,
            userAgent = "Test",
            documentHash = Hash(html),
            screenshotHash = screenshot is null ? null : Hash(screenshot),
            assets = new[] { new { hash = Hash(asset), contentType = "image/png" } },
        });
        return await response.ReadAsync<SnapshotDto>(HttpStatusCode.Created);
    }
}
