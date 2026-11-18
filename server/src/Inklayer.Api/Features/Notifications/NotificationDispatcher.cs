using System.Security.Cryptography;
using System.Text;
using Inklayer.Domain.Notifications;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Notifications;

/// <summary>
/// Sends the outbox: emails, Slack posts and webhook calls. Every few seconds it sends what's due; failures are retried
/// with growing gaps (up to <see cref="OutboundMessage.MaxAttempts"/> tries), and the last error is shown on the
/// integration so admins can see why. Sent and abandoned messages are cleared after a week.
/// </summary>
internal sealed partial class NotificationDispatcher(
    IServiceScopeFactory scopes, IEmailSender email, IHttpClientFactory httpClients, IntegrationSecrets secrets, TimeProvider clock,
    ILogger<NotificationDispatcher> logger) : BackgroundService
{
    public const string HttpClientName = "integrations";
    private const int Batch = 20;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10), clock);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try
                {
                    await RunOnceAsync(stoppingToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    LogFailed(logger, ex);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }

    /// <summary>Sends what's due. Returns how many were sent.</summary>
    public async Task<int> RunOnceAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<InklayerDbContext>();
        var now = clock.GetUtcNow().UtcDateTime;
        var due = await db.OutboundMessages
            .Where(m => m.SentAt == null && m.Attempts < OutboundMessage.MaxAttempts && m.NextAttemptAt <= now)
            .OrderBy(m => m.NextAttemptAt).Take(Batch).ToListAsync(ct);
        var integrationIds = due.Select(m => m.IntegrationId).OfType<Guid>().Distinct().ToList();
        var integrations = await db.Integrations.Where(i => integrationIds.Contains(i.Id)).ToDictionaryAsync(i => i.Id, ct);

        var sent = 0;
        foreach (var message in due)
        {
            var integration = message.IntegrationId is { } id ? integrations.GetValueOrDefault(id) : null;
            try
            {
                await SendAsync(message, integration, ct);
                message.SentAt = clock.GetUtcNow().UtcDateTime;
                message.LastError = null;
                if (integration is not null)
                {
                    integration.LastSuccessAt = message.SentAt;
                }

                sent++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                message.Attempts++;
                message.LastError = Clip(ex.Message);
                message.NextAttemptAt = clock.GetUtcNow().UtcDateTime + TimeSpan.FromMinutes(Math.Min(360, Math.Pow(2, message.Attempts)));
                if (integration is not null)
                {
                    integration.LastError = message.LastError;
                    integration.LastErrorAt = clock.GetUtcNow().UtcDateTime;
                }
            }
        }

        var cutoff = now.AddDays(-7);
        await db.OutboundMessages.Where(m => m.CreatedAt < cutoff && (m.SentAt != null || m.Attempts >= OutboundMessage.MaxAttempts)).ExecuteDeleteAsync(ct);
        await db.SaveChangesAsync(ct);
        return sent;
    }

    /// <summary>Sends one message now. Throws with a readable reason if it fails.</summary>
    public async Task SendAsync(OutboundMessage message, Integration? integration, CancellationToken ct)
    {
        if (message.Kind == IntegrationKinds.Email)
        {
            await email.SendAsync(message.To!, message.Subject, message.Body, ct);
            return;
        }

        if (integration is not { ProtectedUrl: { } protectedUrl })
        {
            throw new InvalidOperationException("The integration was deleted.");
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, secrets.Unprotect(protectedUrl))
        {
            Content = new StringContent(message.Body, Encoding.UTF8, "application/json"),
        };
        if (integration.Kind == IntegrationKinds.Webhook)
        {
            // Receivers check that it came from this server: HMAC-SHA256 of the body with the integration's secret.
            var secret = secrets.Unprotect(integration.ProtectedSecret!);
            var signature = Convert.ToHexStringLower(HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(message.Body)));
            request.Headers.Add("X-Inklayer-Signature", $"sha256={signature}");
            request.Headers.Add("X-Inklayer-Event", message.Subject);
        }

        using var client = httpClients.CreateClient(HttpClientName);
        using var response = await client.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            var detail = await response.Content.ReadAsStringAsync(ct);
            throw new HttpRequestException($"{(int)response.StatusCode} {response.ReasonPhrase}: {Clip(detail)}");
        }
    }

    private static string Clip(string text) => text.Length > 300 ? text[..300] + "…" : text;

    [LoggerMessage(Level = LogLevel.Warning, Message = "Sending notifications failed")]
    private static partial void LogFailed(ILogger logger, Exception exception);
}
