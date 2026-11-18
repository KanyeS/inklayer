using Inklayer.Api.Auditing;
using Inklayer.Domain.Auditing;
using Inklayer.Domain.Organizations;
using Inklayer.Domain.Users;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Inklayer.Api.Auth;

public enum SignInDenialReason
{
    EmailNotVerified,
    NotInvited,
    Disabled,
    AccountConflict,
}

public sealed record SignInDecision(User? User, SignInDenialReason? DenialReason)
{
    public bool IsAllowed => User is not null;
}

/// <summary>
/// Decides whether a Google identity may use this instance, and creates or updates the user. A person gets in if any of these is true:
/// <list type="bullet">
/// <item>they already have an account that isn't disabled;</item>
/// <item>their verified email is in <see cref="InklayerAuthOptions.BootstrapAdmins"/>;</item>
/// <item>they have a pending invitation for their verified email;</item>
/// <item>their Google Workspace domain (<c>hd</c>) is an allowed domain of an organisation.</item>
/// </list>
/// </summary>
public sealed class SignInService(
    InklayerDbContext db,
    IOptions<InklayerAuthOptions> options,
    AuditLog audit,
    TimeProvider clock)
{
    public async Task<SignInDecision> SignInAsync(GoogleIdentity identity, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(identity);
        var now = clock.GetUtcNow().UtcDateTime;

        if (!identity.EmailVerified || identity.Email.Length == 0)
        {
            return await DenyAsync(identity, SignInDenialReason.EmailNotVerified, cancellationToken);
        }

        var user = await db.Users.SingleOrDefaultAsync(u => u.GoogleSubject == identity.Subject, cancellationToken);
        if (user is null && await db.Users.AnyAsync(u => u.Email == identity.Email, cancellationToken))
        {
            // The email belongs to a different Google account (for example, a re-created account). Don't merge them silently.
            return await DenyAsync(identity, SignInDenialReason.AccountConflict, cancellationToken);
        }

        if (user is { IsDisabled: true })
        {
            return await DenyAsync(identity, SignInDenialReason.Disabled, cancellationToken);
        }

        var isBootstrapAdmin = options.Value.BootstrapAdminEmails.Contains(identity.Email);
        var invitations = await db.Invitations
            .Where(i => i.Email == identity.Email && i.AcceptedAt == null && i.ExpiresAt > now)
            .ToListAsync(cancellationToken);
        var domainOrganizationId = identity.HostedDomain is { Length: > 0 } hd
            ? await db.OrganizationDomains.Where(d => d.Domain == hd).Select(d => (Guid?)d.OrganizationId).SingleOrDefaultAsync(cancellationToken)
            : null;

        if (user is null && !isBootstrapAdmin && invitations.Count == 0 && domainOrganizationId is null)
        {
            return await DenyAsync(identity, SignInDenialReason.NotInvited, cancellationToken);
        }

        if (user is null)
        {
            user = new User
            {
                GoogleSubject = identity.Subject,
                Email = identity.Email,
                DisplayName = identity.Name ?? identity.Email,
                CreatedAt = now,
            };
            db.Users.Add(user);
        }

        user.Email = identity.Email;
        user.DisplayName = identity.Name ?? user.DisplayName;
        user.AvatarUrl = identity.Picture;
        user.LastSignInAt = now;
        user.IsSystemAdmin |= isBootstrapAdmin;

        var memberships = await db.OrganizationMembers.Where(m => m.UserId == user.Id).ToListAsync(cancellationToken);

        foreach (var invitation in invitations)
        {
            invitation.AcceptedAt = now;
            var existing = memberships.Find(m => m.OrganizationId == invitation.OrganizationId);
            if (existing is null)
            {
                var member = new OrganizationMember { OrganizationId = invitation.OrganizationId, UserId = user.Id, Role = invitation.Role, JoinedAt = now };
                db.OrganizationMembers.Add(member);
                memberships.Add(member);
            }
            else if (invitation.Role > existing.Role)
            {
                existing.Role = invitation.Role;
            }

            audit.Record(AuditActions.InvitationAccepted, invitation.OrganizationId, "invitation", invitation.Id, new { invitation.Email, invitation.Role }, actorUserId: user.Id);
        }

        if (domainOrganizationId is { } orgId && memberships.TrueForAll(m => m.OrganizationId != orgId))
        {
            var defaultRole = await db.Organizations.Where(o => o.Id == orgId).Select(o => o.DefaultRole).SingleAsync(cancellationToken);
            db.OrganizationMembers.Add(new OrganizationMember { OrganizationId = orgId, UserId = user.Id, Role = defaultRole, JoinedAt = now });
            audit.Record(AuditActions.MemberJoined, orgId, "user", user.Id, new { via = "domain", domain = identity.HostedDomain, role = defaultRole }, actorUserId: user.Id);
        }

        audit.Record(AuditActions.SignInSucceeded, null, "user", user.Id, null, actorUserId: user.Id);
        await db.SaveChangesAsync(cancellationToken);
        return new SignInDecision(user, null);
    }

    private async Task<SignInDecision> DenyAsync(GoogleIdentity identity, SignInDenialReason reason, CancellationToken cancellationToken)
    {
        audit.Record(AuditActions.SignInDenied, null, null, (string?)null, new { identity.Email, reason = reason.ToString() }, actorUserId: null);
        await db.SaveChangesAsync(cancellationToken);
        return new SignInDecision(null, reason);
    }
}
