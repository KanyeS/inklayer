using System.Text.Json;
using Inklayer.Api.Auth;
using Inklayer.Domain.Settings;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Hosting;

/// <summary>A major feature that can be turned off. Page comments are the core and are always on.</summary>
public enum Feature
{
    /// <summary>The organisation knowledge base: docs, graph, live doc editing, and [[links]] between comments and docs.</summary>
    Docs,

    /// <summary>Live presence: cursors, selections and avatars on web pages and in docs.</summary>
    LiveCursors,

    /// <summary>AI assistants: the MCP endpoint, app registration and consent.</summary>
    Mcp,

    /// <summary>Screenshots and page details (browser, console errors, failed requests) captured with each comment.</summary>
    BugContext,

    /// <summary>Linking comments to issues in GitHub, GitLab, Forgejo/Gitea, Jira, Linear and Azure DevOps.</summary>
    IssueTrackers,

    /// <summary>Read-only share links for comments and public docs, reachable from outside the network allow list.</summary>
    Sharing,
}

/// <summary>
/// <c>Inklayer:Features</c>: which features are on when the server starts, e.g. <c>Inklayer__Features__Docs=false</c>
/// (environment) or <c>--Inklayer:Features:Mcp=false</c> (command line). These are starting values: once an instance
/// administrator turns a feature on or off in the Admin panel, their choice wins.
/// </summary>
public sealed class FeatureOptions
{
    public const string SectionName = "Inklayer:Features";

    public bool Docs { get; set; } = true;

    public bool LiveCursors { get; set; } = true;

    public bool Mcp { get; set; } = true;

    public bool BugContext { get; set; } = true;

    public bool IssueTrackers { get; set; } = true;

    public bool Sharing { get; set; } = true;

    public bool this[Feature feature] => feature switch
    {
        Feature.Docs => Docs,
        Feature.LiveCursors => LiveCursors,
        Feature.Mcp => Mcp,
        Feature.BugContext => BugContext,
        Feature.IssueTrackers => IssueTrackers,
        Feature.Sharing => Sharing,
        _ => true,
    };
}

/// <summary>Where a feature's state comes from.</summary>
public enum FeatureSource
{
    /// <summary>On, as it is out of the box.</summary>
    Default,

    /// <summary>Turned off in the server's configuration (a startup argument or environment variable).</summary>
    Config,

    /// <summary>Turned on or off by an instance administrator.</summary>
    Admin,
}

public sealed record FeatureState(bool Enabled, FeatureSource Source);

/// <summary>Which features are on: the server's configuration, then administrators' choices (cached; changed through <see cref="SaveAsync"/>).</summary>
public sealed class FeatureSwitches(IOptions<FeatureOptions> options, IServiceScopeFactory scopes) : IDisposable
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase) } };
    private readonly SemaphoreSlim _loadLock = new(1, 1);
    private Dictionary<Feature, bool>? _saved;

    /// <summary>Raised after an administrator saves, with the features that changed and their new state.</summary>
    public event Action<IReadOnlyDictionary<Feature, bool>>? Changed;

    public async Task<bool> IsEnabledAsync(Feature feature, CancellationToken ct) => (await StatesAsync(ct))[feature].Enabled;

    public async Task<IReadOnlyDictionary<Feature, FeatureState>> StatesAsync(CancellationToken ct)
    {
        var saved = await SavedAsync(ct);
        return Enum.GetValues<Feature>().ToDictionary(f => f, f => saved.TryGetValue(f, out var on)
            ? new FeatureState(on, FeatureSource.Admin)
            : new FeatureState(options.Value[f], options.Value[f] ? FeatureSource.Default : FeatureSource.Config));
    }

    /// <summary>Saves administrators' choices (merged with earlier ones) and applies them straight away.</summary>
    public async Task SaveAsync(IReadOnlyDictionary<Feature, bool> choices, InklayerDbContext db, Guid? userId, DateTime now, CancellationToken ct)
    {
        var before = await StatesAsync(ct);
        var saved = new Dictionary<Feature, bool>(await SavedAsync(ct));
        foreach (var (feature, on) in choices)
        {
            saved[feature] = on;
        }

        var setting = await db.InstanceSettings.SingleOrDefaultAsync(s => s.Key == InstanceSetting.Features, ct);
        if (setting is null)
        {
            setting = new InstanceSetting { Key = InstanceSetting.Features, Value = "" };
            db.InstanceSettings.Add(setting);
        }

        setting.Value = JsonSerializer.Serialize(saved, Json);
        setting.UpdatedAt = now;
        setting.UpdatedByUserId = userId;
        await db.SaveChangesAsync(ct);
        _saved = saved;

        var changed = choices.Where(c => before[c.Key].Enabled != c.Value).ToDictionary(c => c.Key, c => c.Value);
        if (changed.Count > 0)
        {
            Changed?.Invoke(changed);
        }
    }

    public void Dispose() => _loadLock.Dispose();

    private async Task<Dictionary<Feature, bool>> SavedAsync(CancellationToken ct)
    {
        if (_saved is { } saved)
        {
            return saved;
        }

        await _loadLock.WaitAsync(ct);
        try
        {
            if (_saved is null)
            {
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
                var row = await db.InstanceSettings.AsNoTracking().SingleOrDefaultAsync(s => s.Key == InstanceSetting.Features, ct);
                _saved = row is null || row.Value.Length == 0 ? [] : JsonSerializer.Deserialize<Dictionary<Feature, bool>>(row.Value, Json) ?? [];
            }

            return _saved;
        }
        finally
        {
            _loadLock.Release();
        }
    }
}

/// <summary>What the apps need to know: which features to show.</summary>
public sealed record FeaturesResponse(bool Docs, bool LiveCursors, bool Mcp, bool BugContext, bool IssueTrackers, bool Sharing)
{
    public static FeaturesResponse From(IReadOnlyDictionary<Feature, FeatureState> states) =>
        new(states[Feature.Docs].Enabled, states[Feature.LiveCursors].Enabled, states[Feature.Mcp].Enabled,
            states[Feature.BugContext].Enabled, states[Feature.IssueTrackers].Enabled, states[Feature.Sharing].Enabled);
}

internal static class FeatureSwitchExtensions
{
    public static IServiceCollection AddInklayerFeatureSwitches(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<FeatureOptions>(configuration.GetSection(FeatureOptions.SectionName));
        services.AddSingleton<FeatureSwitches>();
        return services;
    }

    /// <summary>
    /// Answers 404 "turned off" for a feature's addresses while it's off, before sign-in or anything else runs. The docs
    /// hub signs in with presence tickets, so tickets stay available while either docs or live cursors are on.
    /// </summary>
    public static WebApplication UseInklayerFeatureSwitches(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path;
            Feature[] needs =
                path.StartsWithSegments("/api/docs", StringComparison.OrdinalIgnoreCase) || IsOrgDocs(path) ? [Feature.Docs]
                : path.StartsWithSegments(Features.Presence.PresenceEndpoints.HubPath, StringComparison.OrdinalIgnoreCase) ? [Feature.LiveCursors]
                : path.StartsWithSegments("/api/presence/ticket", StringComparison.OrdinalIgnoreCase) ? [Feature.LiveCursors, Feature.Docs]
                : IsCommentPart(path, "context") || IsCommentPart(path, "screenshot") ? [Feature.BugContext]
                : IsCommentPart(path, "issues") || IsProjectPart(path, "issue-trackers") ? [Feature.IssueTrackers]
                : path.StartsWithSegments("/api/shares", StringComparison.OrdinalIgnoreCase)
                    || path.StartsWithSegments("/api/public", StringComparison.OrdinalIgnoreCase)
                    || path.StartsWithSegments("/api/admin/shares", StringComparison.OrdinalIgnoreCase) ? [Feature.Sharing]
                : path.StartsWithSegments(McpResource.Path, StringComparison.OrdinalIgnoreCase)
                    || path.StartsWithSegments("/connect/register", StringComparison.OrdinalIgnoreCase)
                    || path.StartsWithSegments("/.well-known/oauth-protected-resource", StringComparison.OrdinalIgnoreCase) ? [Feature.Mcp]
                : [];
            if (needs.Length > 0)
            {
                var switches = context.RequestServices.GetRequiredService<FeatureSwitches>();
                var states = await switches.StatesAsync(context.RequestAborted);
                if (!needs.Any(f => states[f].Enabled))
                {
                    await TypedResults.Problem(statusCode: StatusCodes.Status404NotFound, title: $"{Name(needs[0])} are turned off on this server.").ExecuteAsync(context);
                    return;
                }
            }

            await next(context);
        });
        return app;
    }

    public static string Name(Feature feature) => feature switch
    {
        Feature.Docs => "Docs",
        Feature.LiveCursors => "Live cursors",
        Feature.Mcp => "AI assistants (MCP)",
        Feature.BugContext => "Bug context",
        Feature.IssueTrackers => "Issue trackers",
        Feature.Sharing => "Sharing",
        _ => feature.ToString(),
    };

    /// <summary>/api/annotations/{id}/{part}.</summary>
    private static bool IsCommentPart(PathString path, string part)
    {
        var parts = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 4 && parts[0].Equals("api", StringComparison.OrdinalIgnoreCase)
            && parts[1].Equals("annotations", StringComparison.OrdinalIgnoreCase) && parts[3].Equals(part, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>/api/projects/{id}/{part} and below.</summary>
    private static bool IsProjectPart(PathString path, string part)
    {
        var parts = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 4 && parts[0].Equals("api", StringComparison.OrdinalIgnoreCase)
            && parts[1].Equals("projects", StringComparison.OrdinalIgnoreCase) && parts[3].Equals(part, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>/api/orgs/{id}/docs and below.</summary>
    private static bool IsOrgDocs(PathString path)
    {
        var parts = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length >= 4 && parts[0].Equals("api", StringComparison.OrdinalIgnoreCase)
            && parts[1].Equals("orgs", StringComparison.OrdinalIgnoreCase) && parts[3].Equals("docs", StringComparison.OrdinalIgnoreCase);
    }
}
