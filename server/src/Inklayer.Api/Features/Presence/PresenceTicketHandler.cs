using System.Security.Claims;
using System.Text.Encodings.Web;
using Inklayer.Api.Auth;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Features.Presence;

/// <summary>Signs in the presence connection from the ticket in its <c>access_token</c> query parameter. Only used on the hub's path.</summary>
internal sealed class PresenceTicketHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    PresenceTickets tickets) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "inklayer.presence";

    /// <summary>Claim holding the user's security stamp at the time the ticket was issued.</summary>
    public const string StampClaim = InklayerClaims.SecurityStamp;

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Path.StartsWithSegments(PresenceEndpoints.HubPath, StringComparison.OrdinalIgnoreCase))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        if (tickets.Consume(Request.Query["access_token"]) is not { } ticket)
        {
            return Task.FromResult(AuthenticateResult.Fail("Missing, used or expired presence ticket."));
        }

        var identity = new ClaimsIdentity(SchemeName, InklayerClaims.Name, "role");
        identity.AddClaim(new Claim(InklayerClaims.Subject, ticket.UserId.ToString()));
        identity.AddClaim(new Claim(InklayerClaims.Name, ticket.Name));
        identity.AddClaim(new Claim(StampClaim, ticket.SecurityStamp));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName)));
    }
}
