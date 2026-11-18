using System.Collections.Concurrent;
using System.Net;
using Inklayer.Api.Features.Notifications;

namespace Inklayer.Tests.Infrastructure;

/// <summary>Records emails instead of sending them.</summary>
public sealed class RecordingEmailSender : IEmailSender
{
    public ConcurrentQueue<(string To, string Subject, string Text)> Sent { get; } = new();

    public bool IsConfigured => true;

    public Task SendAsync(string recipient, string subject, string text, CancellationToken ct)
    {
        Sent.Enqueue((recipient, subject, text));
        return Task.CompletedTask;
    }
}

/// <summary>Stands in for Slack, webhooks and issue trackers: records requests, and answers what tests set up (200 by default).</summary>
public sealed class FakeOutboundHandler : HttpMessageHandler
{
    public ConcurrentQueue<(HttpRequestMessage Request, string Body)> Requests { get; } = new();

    /// <summary>Answers for addresses starting with a prefix; the newest matching prefix wins.</summary>
    public ConcurrentDictionary<string, Func<HttpRequestMessage, string, HttpResponseMessage>> Responders { get; } = new();

    public IEnumerable<(HttpRequestMessage Request, string Body)> To(string urlPrefix) =>
        Requests.Where(r => r.Request.RequestUri!.ToString().StartsWith(urlPrefix, StringComparison.Ordinal));

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Enqueue((request, body));
        var url = request.RequestUri!.ToString();
        var responder = Responders.Where(r => url.StartsWith(r.Key, StringComparison.Ordinal)).OrderByDescending(r => r.Key.Length).Select(r => r.Value).FirstOrDefault();
        return responder?.Invoke(request, body) ?? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("ok") };
    }
}
