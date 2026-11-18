namespace Inklayer.Api.Features.Issues;

internal static class IssueSetup
{
    public static IServiceCollection AddInklayerIssues(this IServiceCollection services)
    {
        services.AddSingleton<Trackers>();
        services.AddScoped<IssueService>();
        services.AddSingleton<IssueSyncService>();
        services.AddHostedService(sp => sp.GetRequiredService<IssueSyncService>());
        return services;
    }
}
