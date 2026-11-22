using System.Threading.RateLimiting;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Hosting;

/// <summary>
/// <c>Inklayer:Load</c>: how much work the server takes on at once before it answers "busy, try again" (503 with
/// Retry-After) instead of taking more. Without a limit, a starved server (a Lightsail box out of CPU credits) keeps
/// accepting requests it can't finish until they fill its memory and the container is killed, taking everyone offline.
/// </summary>
public sealed class LoadOptions
{
    public const string SectionName = "Inklayer:Load";

    /// <summary>Requests handled at once. 0 turns the limit (and the queue) off.</summary>
    public int MaxConcurrentRequests { get; set; } = 32;

    /// <summary>Requests waiting for a turn. Past this, a request is refused straight away.</summary>
    public int MaxQueuedRequests { get; set; } = 200;

    /// <summary>How long a request waits for a turn before it is refused.</summary>
    public TimeSpan MaxQueueWait { get; set; } = TimeSpan.FromSeconds(10);

    /// <summary>
    /// New requests are refused while the process uses more than this share of its container's memory limit, before the
    /// kernel kills it at 100%. 0 turns it off; so does running without a memory limit.
    /// </summary>
    public int MaxMemoryPercent { get; set; } = 85;

    /// <summary>What Retry-After says.</summary>
    public int RetryAfterSeconds { get; set; } = 5;
}

/// <summary>
/// An endpoint the load limit leaves alone: an upload streamed to disk for as long as the client takes to send it.
/// Holding a turn for that long would let a few slow uploads lock everyone else out.
/// </summary>
public sealed class NotLoadLimitedMetadata
{
    public static readonly NotLoadLimitedMetadata Instance = new();
}

internal static class LoadSheddingExtensions
{
    public static IServiceCollection AddInklayerLoadShedding(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<LoadOptions>(configuration.GetSection(LoadOptions.SectionName));
        services.AddSingleton(sp => new LoadShedding(
            sp.GetRequiredService<IOptions<LoadOptions>>().Value, ContainerMemory.Probe(), sp.GetRequiredService<ILogger<LoadShedding>>()));
        return services;
    }

    public static WebApplication UseInklayerLoadShedding(this WebApplication app)
    {
        var shedding = app.Services.GetRequiredService<LoadShedding>();
        app.Use((context, next) => shedding.InvokeAsync(context, next));
        return app;
    }

    public static TBuilder NotLoadLimited<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.WithMetadata(NotLoadLimitedMetadata.Instance);
}

/// <summary>
/// Admits a limited number of requests at once, queues a limited number more for a limited time, and refuses the rest
/// with 503 and Retry-After. A refused request never reached its endpoint, so the clients retry any of them, writes
/// included. A turn ends when the response starts, so a long download doesn't hold one.
/// Not limited: live connections (the hubs cap those themselves, see PresenceOptions.MaxConnections), uploads, health checks.
/// </summary>
internal sealed partial class LoadShedding : IDisposable
{
    /// <summary>Set on a refused request's HttpContext.Items, so request logging doesn't write an error line for each.</summary>
    public const string RefusedItem = "Inklayer.LoadRefused";

    private readonly LoadOptions _options;
    private readonly ConcurrencyLimiter? _limiter;
    private readonly Func<double?> _memoryUsed;
    private readonly ILogger _logger;
    private long _refused;
    private long _lastWarningTicks = long.MinValue;

    /// <param name="memoryUsed">The share (0–1) of the memory limit in use, or null if there's no limit to compare with.</param>
    public LoadShedding(LoadOptions options, Func<double?> memoryUsed, ILogger<LoadShedding> logger)
    {
        _options = options;
        _memoryUsed = memoryUsed;
        _logger = logger;
        if (options.MaxConcurrentRequests > 0)
        {
            _limiter = new ConcurrencyLimiter(new ConcurrencyLimiterOptions
            {
                PermitLimit = options.MaxConcurrentRequests,
                QueueLimit = Math.Max(0, options.MaxQueuedRequests),
                QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
            });
        }
    }

    public void Dispose() => _limiter?.Dispose();

    public async Task InvokeAsync(HttpContext context, Func<Task> next)
    {
        if (IsExempt(context))
        {
            await next();
            return;
        }

        if (_options.MaxMemoryPercent > 0 && _memoryUsed() * 100 > _options.MaxMemoryPercent)
        {
            await RefuseAsync(context, "memory");
            return;
        }

        if (_limiter is null)
        {
            await next();
            return;
        }

        RateLimitLease lease;
        using (var wait = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted))
        {
            wait.CancelAfter(_options.MaxQueueWait);
            try
            {
                lease = await _limiter.AcquireAsync(1, wait.Token);
            }
            catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
            {
                await RefuseAsync(context, "queue wait");
                return;
            }
        }

        if (!lease.IsAcquired)
        {
            lease.Dispose();
            await RefuseAsync(context, "queue full");
            return;
        }

        // The turn ends when the response starts (a download then streams without one) or when the request ends.
        var released = 0;
        void Release()
        {
            if (Interlocked.Exchange(ref released, 1) == 0)
            {
                lease.Dispose();
            }
        }

        context.Response.OnStarting(() =>
        {
            Release();
            return Task.CompletedTask;
        });
        try
        {
            await next();
        }
        finally
        {
            Release();
        }
    }

    private static bool IsExempt(HttpContext context)
    {
        if (context.Request.Path.StartsWithSegments("/health", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        var endpoint = context.GetEndpoint();
        return endpoint?.Metadata.GetMetadata<NotLoadLimitedMetadata>() is not null
            || endpoint?.Metadata.GetMetadata<HubMetadata>() is not null;
    }

    private async Task RefuseAsync(HttpContext context, string reason)
    {
        context.Items[RefusedItem] = true;
        var refused = Interlocked.Increment(ref _refused);
        var now = Environment.TickCount64;
        var last = Interlocked.Read(ref _lastWarningTicks);
        if (now - last >= 60_000 && Interlocked.CompareExchange(ref _lastWarningTicks, now, last) == last)
        {
            LogRefusing(_logger, reason, refused);
        }

        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        context.Response.Headers.RetryAfter = _options.RetryAfterSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
        await Results.Problem(
            title: "The server is busy.",
            detail: "Too many requests at once. Try again in a few seconds.",
            statusCode: StatusCodes.Status503ServiceUnavailable).ExecuteAsync(context);
    }

    [LoggerMessage(Level = LogLevel.Warning, Message =
        "The server is overloaded and is refusing requests with 503 (latest reason: {Reason}; {Refused} refused since it started). " +
        "Inklayer:Load sets the limits.")]
    private static partial void LogRefusing(ILogger logger, string reason, long refused);
}

/// <summary>How much of the container's memory limit the process uses, read at most once a second.</summary>
internal static class ContainerMemory
{
    public static Func<double?> Probe()
    {
        if (ReadLimit() is not { } limit)
        {
            return () => null;
        }

        var lastRead = long.MinValue;
        var lastShare = 0d;
        var lastCollect = long.MinValue;
        return () =>
        {
            var now = Environment.TickCount64;
            if (now - Volatile.Read(ref lastRead) < 1000)
            {
                return Volatile.Read(ref lastShare);
            }

            Volatile.Write(ref lastRead, now);
            var share = (double)Environment.WorkingSet / limit;
            Volatile.Write(ref lastShare, share);

            // Memory freed by the GC isn't always handed back straight away; without this, a server that was busy a
            // moment ago could go on refusing requests while idle. At most once every 10 seconds, off the request.
            if (share > 0.8 && now - Volatile.Read(ref lastCollect) >= 10_000)
            {
                Volatile.Write(ref lastCollect, now);
                _ = Task.Run(() => GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true));
            }

            return share;
        };
    }

    /// <summary>The cgroup memory limit (v2, then v1), or null if there is none.</summary>
    private static long? ReadLimit()
    {
        foreach (var path in (string[])["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"])
        {
            try
            {
                if (File.Exists(path) && long.TryParse(File.ReadAllText(path).Trim(), out var limit) && limit is > 0 and < 1L << 50)
                {
                    return limit;
                }
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }

        return null;
    }
}
