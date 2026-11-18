using MailKit;
using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Options;
using MimeKit;

namespace Inklayer.Api.Features.Notifications;

/// <summary>
/// <c>Inklayer:Smtp</c>: the mail server for notification emails, e.g. Amazon SES's SMTP interface. Set through the
/// environment (<c>INKLAYER_SMTP_HOST</c> and so on), never through the web app, so the password stays out of the database.
/// </summary>
public sealed class SmtpOptions
{
    public const string SectionName = "Inklayer:Smtp";

    public string Host { get; set; } = "";

    public int Port { get; set; } = 587;

    public string Username { get; set; } = "";

    public string Password { get; set; } = "";

    /// <summary>The sender, e.g. <c>Inklayer &lt;inklayer@example.com&gt;</c>.</summary>
    public string From { get; set; } = "";

    public bool IsConfigured => Host.Length > 0 && From.Length > 0;
}

/// <summary>Sends one email. Replaced in tests.</summary>
public interface IEmailSender
{
    bool IsConfigured { get; }

    Task SendAsync(string recipient, string subject, string text, CancellationToken ct);
}

internal sealed class SmtpEmailSender(IOptions<SmtpOptions> options) : IEmailSender
{
    public bool IsConfigured => options.Value.IsConfigured;

    public async Task SendAsync(string recipient, string subject, string text, CancellationToken ct)
    {
        var o = options.Value;
        if (!o.IsConfigured)
        {
            throw new InvalidOperationException("Email isn't set up on this server (INKLAYER_SMTP_HOST and INKLAYER_SMTP_FROM).");
        }

        var message = new MimeMessage();
        message.From.Add(MailboxAddress.Parse(o.From));
        message.To.Add(MailboxAddress.Parse(recipient));
        message.Subject = subject;
        message.Body = new TextPart("plain") { Text = text };

        using var client = new SmtpClient();
        await client.ConnectAsync(o.Host, o.Port, o.Port == 465 ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTlsWhenAvailable, ct);
        if (o.Username.Length > 0)
        {
            await client.AuthenticateAsync(o.Username, o.Password, ct);
        }

        await client.SendAsync(new SendRequest(message), ct);
        await client.DisconnectAsync(true, ct);
    }
}
