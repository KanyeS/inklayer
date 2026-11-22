using System.Net;
using Inklayer.Api.Features.Docs;
using Inklayer.Infrastructure.Persistence;
using Inklayer.Tests.Features;
using Inklayer.Tests.Infrastructure;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace Inklayer.Tests.Docs;

/// <summary>
/// Live edits are numbered and sent at once, and saved in batches. These use their own buffer (not the server's, which
/// saves every second) to control when saving happens: a buffer that never saved stands for a server that crashed.
/// </summary>
[Collection(ApiTestGroup.Name)]
public sealed class DocEditBufferTests(InklayerApiFactory factory)
{
    private DocEditBuffer NewBuffer() => new(
        factory.Services.GetRequiredService<IServiceScopeFactory>(), Options.Create(new DocsOptions()), TimeProvider.System, NullLogger<DocEditBuffer>.Instance);

    private async Task<(HttpClient Owner, Guid DocId, Guid UserId)> DocAsync()
    {
        var admin = await factory.SignInAsAdminAsync();
        var org = await Scenario.CreateOrganizationAsync(admin);
        using var created = await admin.PostJsonAsync($"/api/orgs/{org.Id}/docs", new { title = $"Doc {Guid.NewGuid():N}" });
        var doc = await created.ReadAsync<DocSummaryDto>(HttpStatusCode.Created);
        using var me = await admin.GetAsync(new Uri("/api/me", UriKind.Relative));
        return (admin, doc.Id, (await me.ReadAsync<MeDto>()).Id);
    }

    private async Task<(long LastSeq, string Stored)> StoredAsync(Guid docId)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var lastSeq = await db.Docs.Where(d => d.Id == docId).Select(d => d.LastSeq).SingleAsync();
        return (lastSeq, string.Join(",", await db.DocUpdates.Where(u => u.DocId == docId).OrderBy(u => u.Seq).Select(u => u.Seq).ToListAsync()));
    }

    [Fact]
    public async Task Edits_are_numbered_at_once_and_saved_together_later()
    {
        var (owner, docId, userId) = await DocAsync();
        using var buffer = NewBuffer();

        Assert.Equal((1, 0), await buffer.AppendAsync(docId, userId, [1], default));
        Assert.Equal((2, 0), await buffer.AppendAsync(docId, userId, [2], default));
        Assert.Equal((0L, ""), await StoredAsync(docId)); // numbered, not saved yet

        await buffer.FlushAsync(default);
        Assert.Equal((2L, "1,2"), await StoredAsync(docId));

        Assert.Equal((3, 0), await buffer.AppendAsync(docId, userId, [3], default));
        buffer.SnapshotSaved(docId, 3);
        Assert.Equal((4, 3), await buffer.AppendAsync(docId, userId, [4], default));
        await buffer.FlushAsync(default);
        Assert.Equal((4L, "1,2,3,4"), await StoredAsync(docId));
        owner.Dispose();
    }

    [Fact]
    public async Task After_a_crash_numbering_carries_on_from_what_was_saved_without_gaps()
    {
        var (owner, docId, userId) = await DocAsync();
        using (var crashed = NewBuffer())
        {
            await crashed.AppendAsync(docId, userId, [1], default);
            await crashed.FlushAsync(default);
            await crashed.AppendAsync(docId, userId, [2], default); // sent to the others, never saved
        }

        // The restarted server gives number 2 out again: the browsers resend that edit after reconnecting.
        using var restarted = NewBuffer();
        Assert.Equal((2, 0), await restarted.AppendAsync(docId, userId, [2], default));
        await restarted.FlushAsync(default);
        Assert.Equal((2L, "1,2"), await StoredAsync(docId));
        owner.Dispose();
    }

    [Fact]
    public async Task Edits_to_a_deleted_doc_are_dropped_and_refused()
    {
        var (owner, docId, userId) = await DocAsync();
        using var buffer = NewBuffer();
        await buffer.AppendAsync(docId, userId, [1], default);

        using (var doc = await owner.GetAsync(new Uri($"/api/docs/{docId}", UriKind.Relative)))
        {
            var version = (await doc.ReadAsync<System.Text.Json.JsonElement>()).GetProperty("version").GetInt32();
            await owner.DeleteAsync(new Uri($"/api/docs/{docId}?version={version}", UriKind.Relative)).ExpectAsync(HttpStatusCode.NoContent);
        }

        await buffer.FlushAsync(default);
        Assert.Equal((0L, ""), await StoredAsync(docId));
        await Assert.ThrowsAsync<HubException>(() => buffer.AppendAsync(docId, userId, [2], default));
        owner.Dispose();
    }
}
