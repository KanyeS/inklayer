namespace Inklayer.Api.Features.Notifications;

internal static class NotificationSetup
{
    public static IServiceCollection AddInklayerNotifications(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<SmtpOptions>(configuration.GetSection(SmtpOptions.SectionName));
        services.AddSingleton<IEmailSender, SmtpEmailSender>();
        services.AddSingleton<IntegrationSecrets>();
        services.AddScoped<NotificationService>();
        services.AddSingleton<NotificationDispatcher>();
        services.AddHostedService(sp => sp.GetRequiredService<NotificationDispatcher>());
        services.AddHttpClient(NotificationDispatcher.HttpClientName, c => c.Timeout = TimeSpan.FromSeconds(10));
        return services;
    }
}
