using System.ComponentModel.DataAnnotations;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Auth;

/// <param name="Id">Part of the redirect URI; can't be changed.</param>
/// <param name="Kind"><c>google</c> or <c>oidc</c>.</param>
/// <param name="Authority">The issuer address. Not shown for providers from the server's configuration.</param>
/// <param name="Accounts">How many people have signed in with it.</param>
/// <param name="CanRemove">An administrator added it, so it can be changed or removed here.</param>
/// <param name="NeedsSecret">Its client secret can't be decrypted (the database was restored without the server's keys): enter it again to bring it back.</param>
public sealed record SignInProviderResponse(
    string Id, string DisplayName, string Kind, SignInProviderSource Source, string RedirectUri, int Accounts,
    string? Authority = null, string? ClientId = null, bool HasClientSecret = false, string? Scopes = null,
    IReadOnlyList<string>? VerifiedDomains = null, bool CanRemove = false, bool NeedsSecret = false);

/// <param name="RedirectUriPrefix">The redirect URI to register at a new provider is this followed by its id.</param>
/// <param name="YourProviders">The providers the caller signs in with, so the page can warn before they remove their own.</param>
public sealed record SignInProvidersResponse(IReadOnlyList<SignInProviderResponse> Providers, string RedirectUriPrefix, IReadOnlyList<string> YourProviders);

/// <param name="ClientSecret">On a change, leave it out (or null) to keep the current secret; an empty string removes it (a public client).</param>
public sealed record SaveSignInProviderRequest(
    [property: MaxLength(32)] string? Id,
    [property: Required, MaxLength(80)] string? DisplayName,
    [property: Required, MaxLength(500)] string? Authority,
    [property: Required, MaxLength(500)] string? ClientId,
    [property: MaxLength(2000)] string? ClientSecret,
    [property: MaxLength(500)] string? Scopes,
    List<string>? VerifiedDomains);

/// <summary>Instance administrators add OpenID Connect sign-in providers without editing the server's configuration (mapped under the admin-only group).</summary>
internal static class SignInProviderEndpoints
{
    private const string DefaultScopes = "openid email profile";

    public static RouteGroupBuilder MapSignInProviderEndpoints(this RouteGroupBuilder admin)
    {
        admin.MapGet("/sign-in-providers", async (HttpContext context, SignInProviders providers, CurrentUser currentUser, InklayerDbContext db, CancellationToken ct) =>
            TypedResults.Ok(await ListAsync(context, providers, currentUser.Id!.Value, db, ct)))
            .WithSummary("The sign-in providers: those in the server's configuration, and those administrators added");

        admin.MapPost("/sign-in-providers", async (SaveSignInProviderRequest request, HttpContext context, SignInProviders providers,
            CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct) =>
        {
            var provider = ToOptions((request.Id ?? "").Trim(), request);
            var errors = await providers.CheckAsync(provider, isNew: true, ct);
            if (errors.Count > 0)
            {
                return Results.ValidationProblem(errors);
            }

            await providers.SaveAsync(provider, request.ClientSecret?.Trim() ?? "", currentUser.Id!.Value, ct);
            audit.Record(AuditActions.SignInProviderAdded, null, "sign_in_provider", provider.Id, Described(provider));
            await db.SaveChangesAsync(ct);
            return Results.Ok(await ListAsync(context, providers, currentUser.Id!.Value, db, ct));
        }).Produces<SignInProvidersResponse>().WithSummary("Add an OpenID Connect sign-in provider. Its discovery document is checked first; it works straight away.");

        admin.MapPut("/sign-in-providers/{id}", async (string id, SaveSignInProviderRequest request, HttpContext context, SignInProviders providers,
            CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct) =>
        {
            if (Refusal(id, providers) is { } refusal)
            {
                return refusal;
            }

            if (providers.NeedsSecret(id) && string.IsNullOrWhiteSpace(request.ClientSecret))
            {
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["clientSecret"] = ["The saved secret can't be read on this server any more. Enter it again."],
                });
            }

            var provider = ToOptions(id, request);
            var errors = await providers.CheckAsync(provider, isNew: false, ct);
            if (errors.Count > 0)
            {
                return Results.ValidationProblem(errors);
            }

            await providers.SaveAsync(provider, request.ClientSecret?.Trim(), currentUser.Id!.Value, ct);
            audit.Record(AuditActions.SignInProviderChanged, null, "sign_in_provider", id, Described(provider));
            await db.SaveChangesAsync(ct);
            return Results.Ok(await ListAsync(context, providers, currentUser.Id!.Value, db, ct));
        }).Produces<SignInProvidersResponse>().WithSummary("Change a provider an administrator added. Leave out the client secret to keep it.");

        admin.MapDelete("/sign-in-providers/{id}", async (string id, HttpContext context, SignInProviders providers,
            CurrentUser currentUser, InklayerDbContext db, AuditLog audit, CancellationToken ct) =>
        {
            if (Refusal(id, providers) is { } refusal)
            {
                return refusal;
            }

            if (providers.All.Count == 1)
            {
                return Results.Problem(statusCode: StatusCodes.Status409Conflict,
                    title: "This is the only sign-in provider, so nobody could sign in without it. Add another one first.");
            }

            var yours = await YourProvidersAsync(currentUser.Id!.Value, providers, db, ct);
            if (yours.SequenceEqual([id]))
            {
                return Results.Problem(statusCode: StatusCodes.Status409Conflict,
                    title: "You only sign in with this provider, so removing it would lock you out. Sign in once with another provider first.");
            }

            await providers.RemoveAsync(id, currentUser.Id!.Value, ct);
            audit.Record(AuditActions.SignInProviderRemoved, null, "sign_in_provider", id);
            await db.SaveChangesAsync(ct);
            return Results.Ok(await ListAsync(context, providers, currentUser.Id!.Value, db, ct));
        }).Produces<SignInProvidersResponse>().WithSummary("Remove a provider an administrator added. People who used only it can no longer sign in.");

        return admin;
    }

    /// <summary>Only providers administrators added can be changed here; the configuration's are changed there.</summary>
    private static IResult? Refusal(string id, SignInProviders providers) =>
        providers.Configured.Any(p => p.Id == id)
            ? Results.Problem(statusCode: StatusCodes.Status409Conflict,
                title: "This provider is set in the server's configuration. Change it there and restart the server.")
            : providers.Added.Any(p => p.Id == id) ? null : Results.NotFound();

    private static InklayerAuthOptions.OidcProviderOptions ToOptions(string id, SaveSignInProviderRequest request) => new()
    {
        Id = id,
        DisplayName = request.DisplayName!.Trim(),
        Authority = request.Authority!.Trim(),
        ClientId = request.ClientId!.Trim(),
        Scopes = string.IsNullOrWhiteSpace(request.Scopes) ? DefaultScopes : string.Join(' ', request.Scopes.Split(' ', StringSplitOptions.RemoveEmptyEntries)),
        VerifiedDomains = string.Join(", ", InklayerAuthOptions.Split(string.Join(',', request.VerifiedDomains ?? []))),
    };

    /// <summary>What the audit log keeps about a provider: never the secret.</summary>
    private static object Described(InklayerAuthOptions.OidcProviderOptions provider) =>
        new { provider.DisplayName, provider.Authority, provider.ClientId, provider.Scopes, provider.VerifiedDomains };

    private static async Task<SignInProvidersResponse> ListAsync(HttpContext context, SignInProviders providers, Guid userId, InklayerDbContext db, CancellationToken ct)
    {
        var prefix = $"{context.Request.Scheme}://{context.Request.Host}/auth/callback/";
        var accounts = await db.UserLogins.AsNoTracking().GroupBy(l => l.Provider).Select(g => new { g.Key, Count = g.Count() })
            .ToDictionaryAsync(g => g.Key, g => g.Count, ct);
        int Accounts(string id) => accounts.GetValueOrDefault(id);

        var list = providers.Configured.Select(p => new SignInProviderResponse(p.Id, p.DisplayName, p.Id == AuthSchemes.Google ? "google" : "oidc",
                SignInProviderSource.Config, prefix + p.Id, Accounts(p.Id)))
            .Concat(providers.Added.Select(a => new SignInProviderResponse(a.Id, a.DisplayName.Length > 0 ? a.DisplayName : a.Id, "oidc",
                SignInProviderSource.Admin, prefix + a.Id, Accounts(a.Id), a.Authority, a.ClientId, a.ProtectedClientSecret is not null, a.Scopes,
                [.. InklayerAuthOptions.Split(a.VerifiedDomains)], CanRemove: true, NeedsSecret: providers.NeedsSecret(a.Id))))
            .ToList();

        return new SignInProvidersResponse(list, prefix, await YourProvidersAsync(userId, providers, db, ct));
    }

    /// <summary>The providers, still set up, that this person has signed in with.</summary>
    private static async Task<IReadOnlyList<string>> YourProvidersAsync(Guid userId, SignInProviders providers, InklayerDbContext db, CancellationToken ct)
    {
        var ids = providers.All.Select(p => p.Id).ToHashSet(StringComparer.Ordinal);
        var logins = await db.UserLogins.AsNoTracking().Where(l => l.UserId == userId).Select(l => l.Provider).ToListAsync(ct);
        return [.. logins.Where(ids.Contains).Distinct().Order(StringComparer.Ordinal)];
    }
}
