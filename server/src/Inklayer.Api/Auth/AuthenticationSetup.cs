using System.Threading.RateLimiting;
using Inklayer.Api.Access;
using Inklayer.Api.Auditing;
using Inklayer.Infrastructure;
using Inklayer.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.OpenIdConnect;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;
using Microsoft.IdentityModel.Tokens;
using OpenIddict.Abstractions;
using ModelContextProtocol.AspNetCore.Authentication;
using ModelContextProtocol.Authentication;
using OpenIddict.Server;
using OpenIddict.Validation.AspNetCore;
using static OpenIddict.Abstractions.OpenIddictConstants;

namespace Inklayer.Api.Auth;

internal static partial class AuthenticationSetup
{
    public const string AuthRateLimitPolicy = "auth";

    public static IServiceCollection AddInklayerAuth(this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment)
    {
        var authSection = configuration.GetSection(InklayerAuthOptions.SectionName);
        services.AddOptions<InklayerAuthOptions>().Bind(authSection);
        var authOptions = authSection.Get<InklayerAuthOptions>() ?? new InklayerAuthOptions();
        var allowInsecureHttp = authOptions.AllowInsecureHttp || environment.IsDevelopment();
        authOptions.Validate(allowInsecureHttp);

        services.AddHttpContextAccessor();
        services.AddMemoryCache();
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<SessionGuard>();
        services.AddScoped<CurrentUser>();
        services.AddScoped<AccessService>();
        services.AddScoped<AuditLog>();
        services.AddScoped<SignInService>();

        // Data Protection protects the session cookie and OAuth correlation cookies. Keys are stored on the data volume.
        services.AddDataProtection().SetApplicationName("inklayer");
        services.AddOptions<KeyManagementOptions>()
            .Configure<DataPaths, ILoggerFactory>((o, paths, loggers) =>
                o.XmlRepository = new FileSystemXmlRepository(new DirectoryInfo(Path.Combine(paths.Keys, "dataprotection")), loggers));

        var authentication = services
            .AddAuthentication(o =>
            {
                o.DefaultScheme = AuthSchemes.Default;
                o.DefaultChallengeScheme = AuthSchemes.Default;
            })
            .AddPolicyScheme(AuthSchemes.Default, displayName: null, o => o.ForwardDefaultSelector = context =>
                context.Request.Headers.Authorization.ToString().StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
                    ? OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme
                    : AuthSchemes.Cookie)
            .AddCookie(AuthSchemes.Cookie, o =>
            {
                o.Cookie.Name = "inklayer.session";
                o.Cookie.Path = "/";
                o.Cookie.HttpOnly = true;
                o.Cookie.SameSite = SameSiteMode.Lax;
                o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
                o.ExpireTimeSpan = TimeSpan.FromDays(14);
                o.SlidingExpiration = true;
                o.LoginPath = "/auth/login";
                o.ReturnUrlParameter = "returnUrl";
                o.AccessDeniedPath = "/auth/denied";
                o.Events = new CookieAuthenticationEvents
                {
                    OnValidatePrincipal = SessionGuard.ValidatePrincipalAsync,
                    // APIs answer with status codes; only browser navigation is redirected to sign-in.
                    OnRedirectToLogin = ctx => RedirectOrStatus(ctx, StatusCodes.Status401Unauthorized),
                    OnRedirectToAccessDenied = ctx => RedirectOrStatus(ctx, StatusCodes.Status403Forbidden),
                };
            });

        if (authOptions.Google.IsConfigured)
        {
            authentication.AddOpenIdConnect(AuthSchemes.Google, "Google", o =>
            {
                o.Authority = "https://accounts.google.com";
                o.ClientId = authOptions.Google.ClientId;
                o.ClientSecret = authOptions.Google.ClientSecret;
                o.ResponseType = "code";
                o.UsePkce = true;
                o.CallbackPath = "/auth/callback/google";
                o.SignInScheme = AuthSchemes.Cookie;
                o.Scope.Clear();
                o.Scope.Add("openid");
                o.Scope.Add("email");
                o.Scope.Add("profile");
                o.MapInboundClaims = false;
                o.SaveTokens = false;
                o.GetClaimsFromUserInfoEndpoint = true;
                o.Events = new OpenIdConnectEvents
                {
                    OnRedirectToIdentityProvider = ctx =>
                    {
                        ctx.ProtocolMessage.Prompt = "select_account";
                        return Task.CompletedTask;
                    },
                    OnTicketReceived = ctx => CompleteSignInAsync(ctx, ExternalIdentity.FromGoogle(ctx.Principal!)),
                    OnRemoteFailure = OnRemoteFailureAsync,
                };
            });
        }

        foreach (var provider in authOptions.Oidc.Where(o => o.IsConfigured))
        {
            authentication.AddOpenIdConnect(AuthSchemes.ForProvider(provider.Id), provider.DisplayNameOrId, o =>
            {
                o.Authority = provider.Authority;
                o.ClientId = provider.ClientId;
                o.ClientSecret = provider.ClientSecret.Length > 0 ? provider.ClientSecret : null;
                o.ResponseType = "code";
                o.UsePkce = true;
                o.CallbackPath = $"/auth/callback/{provider.Id}";
                o.SignInScheme = AuthSchemes.Cookie;
                o.RequireHttpsMetadata = !allowInsecureHttp;
                o.Scope.Clear();
                o.Scope.Add("openid");
                foreach (var scope in provider.Scopes.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(s => s != "openid"))
                {
                    o.Scope.Add(scope);
                }

                o.MapInboundClaims = false;
                o.SaveTokens = false;

                // Some providers put email and name only in the userinfo response, not in the ID token.
                o.GetClaimsFromUserInfoEndpoint = true;
                o.ClaimActions.MapUniqueJsonKey("email_verified", "email_verified");
                o.ClaimActions.MapUniqueJsonKey("picture", "picture");
                o.Events = new OpenIdConnectEvents
                {
                    // Runs after the ID token and the userinfo response are both in.
                    OnTicketReceived = ctx => CompleteSignInAsync(ctx, ExternalIdentity.FromOidc(ctx.Principal!, provider)),
                    OnRemoteFailure = OnRemoteFailureAsync,
                };
            });
        }

        // MCP: bearer tokens like the extension's, but challenges point clients at the protected-resource metadata
        // (/.well-known/oauth-protected-resource/api/mcp), which says where to sign in. Tokens must be issued for the MCP endpoint.
        authentication
            .AddPolicyScheme(AuthSchemes.Mcp, displayName: null, o =>
            {
                o.ForwardAuthenticate = OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme;
                o.ForwardChallenge = McpAuthenticationDefaults.AuthenticationScheme;
                o.ForwardForbid = OpenIddictValidationAspNetCoreDefaults.AuthenticationScheme;
            })
            .AddMcp(o =>
            {
                o.ResourceMetadata = new ProtectedResourceMetadata { ResourceName = "Inklayer" };
                o.Events.OnResourceMetadataRequest = context =>
                {
                    var origin = McpResource.Origin(context.HttpContext.Request);
                    context.ResourceMetadata = new ProtectedResourceMetadata
                    {
                        Resource = McpResource.Uri(context.HttpContext.Request),
                        AuthorizationServers = [origin + "/"],
                        ScopesSupported = [McpResource.Scope, Scopes.OfflineAccess],
                        BearerMethodsSupported = ["header"],
                        ResourceName = "Inklayer",
                    };
                    return Task.CompletedTask;
                };
            });

        services.AddAuthorization(o => o.AddPolicy(McpResource.Policy, policy => policy
            .AddAuthenticationSchemes(AuthSchemes.Mcp)
            .RequireAuthenticatedUser()
            .RequireAssertion(context => context.Resource is HttpContext http
                && context.User.GetAudiences().Contains(McpResource.Uri(http.Request), StringComparer.Ordinal))));
        services.AddAntiforgery(o => o.Cookie.Name = "inklayer.consent");

        services.AddOpenIddict()
            .AddCore(o => o.UseEntityFrameworkCore().UseDbContext<InklayerDbContext>())
            .AddServer(o =>
            {
                o.SetAuthorizationEndpointUris("connect/authorize")
                    .SetTokenEndpointUris("connect/token")
                    // MCP clients look for RFC 8414 metadata; OpenID Connect clients for the usual document. Same content.
                    .SetConfigurationEndpointUris(".well-known/openid-configuration", ".well-known/oauth-authorization-server");
                o.AllowAuthorizationCodeFlow().AllowRefreshTokenFlow();
                o.RequireProofKeyForCodeExchange();
                // S256 only: "plain" PKCE protects nothing if the request is seen (OAuth 2.1, MCP authorization spec).
                o.Configure(options => options.CodeChallengeMethods.Remove(CodeChallengeMethods.Plain));
                o.RegisterScopes(Scopes.OpenId, Scopes.Email, Scopes.Profile, Scopes.OfflineAccess, McpResource.Scope);

                // The one resource (RFC 8707) is the MCP endpoint, whose address depends on how the server is reached, so the
                // authorization endpoint checks it rather than a fixed list (see AuthEndpoints.AuthorizeAsync).
                o.DisableResourceValidation();

                // Apps such as Claude register themselves (RFC 7591) at /connect/register.
                o.AddEventHandler<OpenIddictServerEvents.HandleConfigurationRequestContext>(builder => builder.UseInlineHandler(context =>
                {
                    context.Metadata["registration_endpoint"] = new Uri(context.BaseUri!, "connect/register").AbsoluteUri;
                    return default;
                }));
                o.SetAccessTokenLifetime(TimeSpan.FromMinutes(15));
                o.SetRefreshTokenLifetime(TimeSpan.FromDays(30));

                var aspNetCore = o.UseAspNetCore()
                    .EnableAuthorizationEndpointPassthrough()
                    .EnableTokenEndpointPassthrough();
                if (allowInsecureHttp)
                {
                    aspNetCore.DisableTransportSecurityRequirement();
                }
            })
            .AddValidation(o =>
            {
                o.UseLocalServer();
                o.UseAspNetCore();
                // Look up each token in the database, so revoking it (disable user, "sign out everywhere") takes effect immediately.
                o.EnableTokenEntryValidation();
                o.EnableAuthorizationEntryValidation();
            });

        // Signing and encryption keys are persisted on the data volume (see ServerKeys).
        services.AddOptions<OpenIddictServerOptions>().Configure<DataPaths>((o, paths) =>
        {
            o.SigningCredentials.Add(new SigningCredentials(ServerKeys.LoadOrCreate(paths, "token-signing"), SecurityAlgorithms.RsaSha256));
            o.EncryptionCredentials.Add(new EncryptingCredentials(
                ServerKeys.LoadOrCreate(paths, "token-encryption"), SecurityAlgorithms.RsaOAEP, SecurityAlgorithms.Aes256CbcHmacSha512));
        });

        services.AddHostedService<ExtensionClientSeeder>();
        services.AddHostedService<TokenPruningService>();

        services.AddRateLimiter(o =>
        {
            o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            o.AddPolicy(AuthRateLimitPolicy, context => RateLimitPartition.GetFixedWindowLimiter(
                context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions { PermitLimit = authOptions.AuthRequestsPerMinute, Window = TimeSpan.FromMinutes(1) }));
        });

        return services;
    }

    public static WebApplication UseInklayerAuth(this WebApplication app)
    {
        app.UseRateLimiter();
        app.UseAuthentication();

        // A token issued for the MCP endpoint is only good there: it can't be passed along to the rest of the API.
        app.Use((context, next) =>
        {
            if (context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase)
                && !context.Request.Path.StartsWithSegments(McpResource.Path, StringComparison.OrdinalIgnoreCase)
                && context.User.GetAudiences().Any(a => a.EndsWith(McpResource.Path, StringComparison.Ordinal)))
            {
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return Task.CompletedTask;
            }

            return next(context);
        });
        app.UseAuthorization();
        app.UseMiddleware<CsrfMiddleware>();
        return app;
    }

    /// <summary>Runs the sign-in rules and replaces the provider's claims with Inklayer's own. Only Inklayer's user id, email, name and security stamp go into the cookie.</summary>
    private static async Task CompleteSignInAsync(TicketReceivedContext context, ExternalIdentity identity)
    {
        var signIn = context.HttpContext.RequestServices.GetRequiredService<SignInService>();
        var decision = await signIn.SignInAsync(identity, context.HttpContext.RequestAborted);

        if (!decision.IsAllowed)
        {
            context.HandleResponse();
            context.Response.Redirect($"/auth/denied?reason={decision.DenialReason}");
            return;
        }

        context.Principal = PrincipalFactory.CreateCookiePrincipal(decision.User!);
    }

    private static Task OnRemoteFailureAsync(RemoteFailureContext context)
    {
        LogRemoteFailure(context.HttpContext.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(AuthenticationSetup)), context.Scheme.Name, context.Failure);
        context.HandleResponse();
        context.Response.Redirect("/auth/denied?reason=ProviderError");
        return Task.CompletedTask;
    }

    private static Task RedirectOrStatus(Microsoft.AspNetCore.Authentication.RedirectContext<CookieAuthenticationOptions> context, int statusCode)
    {
        if (context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = statusCode;
        }
        else
        {
            context.Response.Redirect(context.RedirectUri);
        }

        return Task.CompletedTask;
    }

    [LoggerMessage(Level = LogLevel.Warning, Message = "Sign-in with {Scheme} failed")]
    private static partial void LogRemoteFailure(ILogger logger, string scheme, Exception? exception);
}
