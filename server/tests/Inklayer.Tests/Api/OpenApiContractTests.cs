using System.Text.Json;
using System.Text.Json.Nodes;
using Inklayer.Tests.Infrastructure;

namespace Inklayer.Tests.Api;

/// <summary>
/// The client generates its API types from a copy of the OpenAPI document (<c>client/packages/api/openapi.json</c>).
/// This test fails when the server's document no longer matches that copy, so the two can't drift apart.
/// Run it with <c>INKLAYER_UPDATE_OPENAPI=1</c> to rewrite the copy, then run <c>pnpm api:generate</c> in <c>client/</c>.
/// </summary>
[Collection(ApiTestGroup.Name)]
public sealed class OpenApiContractTests(InklayerApiFactory factory)
{
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    [Fact]
    public async Task Client_copy_of_the_OpenAPI_document_is_up_to_date()
    {
        using var client = factory.CreateClient();
        var json = await client.GetStringAsync(new Uri("/openapi/v1.json", UriKind.Relative));
        var document = JsonNode.Parse(json)!;
        // The server address depends on where it runs; it isn't part of the contract.
        document.AsObject().Remove("servers");
        var current = document.ToJsonString(Indented).ReplaceLineEndings("\n") + "\n";

        var path = Path.Combine(RepositoryRoot(), "client", "packages", "api", "openapi.json");
        if (Environment.GetEnvironmentVariable("INKLAYER_UPDATE_OPENAPI") == "1")
        {
            await File.WriteAllTextAsync(path, current);
            return;
        }

        var committed = File.Exists(path) ? (await File.ReadAllTextAsync(path)).ReplaceLineEndings("\n") : "";
        Assert.True(
            committed == current,
            "client/packages/api/openapi.json is out of date. Run the server tests with INKLAYER_UPDATE_OPENAPI=1, then `pnpm api:generate` in client/.");
    }

    private static string RepositoryRoot()
    {
        for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "client", "packages")) && Directory.Exists(Path.Combine(dir.FullName, "server")))
            {
                return dir.FullName;
            }
        }

        throw new DirectoryNotFoundException("Couldn't find the repository root above " + AppContext.BaseDirectory);
    }
}
