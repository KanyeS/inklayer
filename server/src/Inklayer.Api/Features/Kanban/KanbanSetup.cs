namespace Inklayer.Api.Features.Kanban;

internal static class KanbanSetup
{
    public static IServiceCollection AddInklayerKanban(this IServiceCollection services)
    {
        services.AddScoped<KanbanEditor>();
        services.AddScoped<KanbanSync>();
        services.AddSingleton<KanbanSyncService>();
        services.AddHostedService(sp => sp.GetRequiredService<KanbanSyncService>());
        services.AddSingleton<TaskDueService>();
        services.AddHostedService(sp => sp.GetRequiredService<TaskDueService>());
        return services;
    }
}
