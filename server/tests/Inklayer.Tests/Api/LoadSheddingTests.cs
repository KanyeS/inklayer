using Inklayer.Api.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Inklayer.Tests.Api;

/// <summary>
/// An overloaded server refuses work it can't take on (503, Retry-After) instead of taking it all on and running out of
/// memory: on a Lightsail box out of CPU credits, unfinished requests piled up until the container was killed.
/// </summary>
public sealed class LoadSheddingTests : IDisposable
{
    private readonly List<LoadShedding> _limiters = [];

    public void Dispose() => _limiters.ForEach(l => l.Dispose());

    private LoadShedding Limiter(int concurrent = 1, int queued = 0, int waitMs = 5_000, double? memory = 0.1)
    {
        var limiter = new LoadShedding(
            new LoadOptions { MaxConcurrentRequests = concurrent, MaxQueuedRequests = queued, MaxQueueWait = TimeSpan.FromMilliseconds(waitMs) },
            () => memory,
            NullLogger<LoadShedding>.Instance);
        _limiters.Add(limiter);
        return limiter;
    }

    private static DefaultHttpContext Request(string path = "/api/me", object? metadata = null)
    {
        var services = new ServiceCollection().AddLogging().AddProblemDetails().BuildServiceProvider();
        var context = new DefaultHttpContext { RequestServices = services };
        context.Request.Path = path;
        context.Response.Body = new MemoryStream();
        context.Features.Set<IHttpResponseFeature>(new StartableResponse());
        if (metadata is not null)
        {
            context.SetEndpoint(new Endpoint(null, new EndpointMetadataCollection(metadata), "test"));
        }

        return context;
    }

    /// <summary>A request that stays in its handler until released.</summary>
    private static (Task Running, TaskCompletionSource Release, TaskCompletionSource Entered) Hold(LoadShedding limiter, HttpContext context)
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var running = limiter.InvokeAsync(context, async () =>
        {
            entered.SetResult();
            await release.Task;
        });
        return (running, release, entered);
    }

    private static async Task<(bool Ran, HttpContext Context)> SendAsync(LoadShedding limiter, HttpContext? context = null)
    {
        context ??= Request();
        var ran = false;
        await limiter.InvokeAsync(context, () =>
        {
            ran = true;
            return Task.CompletedTask;
        });
        return (ran, context);
    }

    private static void AssertRefused((bool Ran, HttpContext Context) result)
    {
        Assert.False(result.Ran);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, result.Context.Response.StatusCode);
        Assert.Equal("5", result.Context.Response.Headers.RetryAfter.ToString());
        Assert.True(result.Context.Items.ContainsKey(LoadShedding.RefusedItem));
    }

    [Fact]
    public async Task Past_the_limit_and_the_queue_a_request_is_refused_before_it_runs()
    {
        var limiter = Limiter(concurrent: 1, queued: 0);
        var busy = Hold(limiter, Request());
        await busy.Entered.Task;

        AssertRefused(await SendAsync(limiter));

        busy.Release.SetResult();
        await busy.Running;
        Assert.True((await SendAsync(limiter)).Ran);
    }

    [Fact]
    public async Task A_queued_request_runs_when_a_turn_frees_up()
    {
        var limiter = Limiter(concurrent: 1, queued: 1);
        var busy = Hold(limiter, Request());
        await busy.Entered.Task;

        var queued = SendAsync(limiter);
        await Task.Delay(50);
        Assert.False(queued.IsCompleted);
        AssertRefused(await SendAsync(limiter)); // the queue holds one

        busy.Release.SetResult();
        Assert.True((await queued).Ran);
    }

    [Fact]
    public async Task A_request_that_waits_too_long_is_refused()
    {
        var limiter = Limiter(concurrent: 1, queued: 5, waitMs: 100);
        var busy = Hold(limiter, Request());
        await busy.Entered.Task;

        AssertRefused(await SendAsync(limiter));
        busy.Release.SetResult();
        await busy.Running;
    }

    [Fact]
    public async Task A_turn_ends_when_the_response_starts()
    {
        var limiter = Limiter(concurrent: 1, queued: 0);
        var download = Request();
        var busy = Hold(limiter, download);
        await busy.Entered.Task;

        // Headers sent: the rest of a download streams without holding a turn.
        await ((StartableResponse)download.Features.Get<IHttpResponseFeature>()!).StartAsync();
        Assert.True((await SendAsync(limiter)).Ran);

        busy.Release.SetResult();
        await busy.Running;
    }

    [Fact]
    public async Task Live_connections_uploads_and_health_checks_are_not_limited()
    {
        // Full, and nearly out of memory: an ordinary request is refused, these still go through.
        var limiter = Limiter(concurrent: 1, queued: 0);
        var busy = Hold(limiter, Request());
        await busy.Entered.Task;
        AssertRefused(await SendAsync(limiter));
        var starved = Limiter(concurrent: 1, queued: 0, memory: 0.99);

        foreach (var l in new[] { limiter, starved })
        {
            Assert.True((await SendAsync(l, Request(metadata: new HubMetadata(typeof(Hub))))).Ran);
            Assert.True((await SendAsync(l, Request(metadata: NotLoadLimitedMetadata.Instance))).Ran);
            Assert.True((await SendAsync(l, Request("/health/ready"))).Ran);
        }

        busy.Release.SetResult();
        await busy.Running;
    }

    [Fact]
    public async Task Near_the_memory_limit_new_requests_are_refused()
    {
        AssertRefused(await SendAsync(Limiter(concurrent: 10, memory: 0.9)));
        Assert.True((await SendAsync(Limiter(concurrent: 10, memory: 0.8))).Ran);
        Assert.True((await SendAsync(Limiter(concurrent: 10, memory: null))).Ran); // no container limit
    }

    /// <summary>A response feature whose OnStarting callbacks run when the test says the response started.</summary>
    private sealed class StartableResponse : HttpResponseFeature
    {
        private readonly List<(Func<object, Task> Callback, object State)> _starting = [];

        public override void OnStarting(Func<object, Task> callback, object state) => _starting.Add((callback, state));

        public async Task StartAsync()
        {
            foreach (var (callback, state) in _starting)
            {
                await callback(state);
            }
        }
    }
}
