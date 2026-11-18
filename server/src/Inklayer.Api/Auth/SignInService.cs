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
/// Decides whether a sign-in from Google or another OpenID Connect provider may use this instance, and creates or updates
/// the user. A person gets in if any of these is true:
/// <list type="bullet">
/// <item>they already have an account that isn't disabled;</item>
/// <item>their verified email is in <see cref="InklayerAuthOptions.BootstrapAdmins"/>;</item>
/// <item>they have a pending invitation for their verified email;</item>
/// <item>their verified domain (Google Workspace <c>hd</c>, or a provider's <c>VerifiedDomains</c>) is an allowed domain of an organisation.</item>
/// </list>
/// </summary>
public sealed class SignInService(
    InklayerDbContext db,
    IOptions<InklayerAuthOptions> options,
    AuditLog audit,
    TimeProvider clock)
{
    public async Task<SignInDecision> SignInAsync(ExternalIdentity identity, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(identity);
        var now = clock.GetUtcNow().UtcDateTime;

        if (!identity.EmailVerified || identity.Email.Length == 0)
        {
            return await DenyAsync(identity, SignInDenialReason.EmailNotVerified, cancellationToken);
        }

        var user = await db.UserLogins
            .Where(l => l.Provider == identity.Provider && l.Subject == identity.Subject)
            .Join(db.Users, l => l.UserId, u => u.Id, (_, u) => u)
            .SingleOrDefaultAsync(cancellationToken);
        if (user is null && await db.Users.SingleOrDefaultAsync(u => u.Email == identity.Email, cancellationToken) is { } emailOwner)
        {
            // The email already has an account. Link this provider to it only if the provider is the authority for the
            // email's domain and the account has no other login at this provider. Otherwise (for example, a re-created
            // Google account, or a provider that merely asserts the address) don't merge them silently.
            var hasLoginAtProvider = await db.UserLogins.AnyAsync(l => l.UserId == emailOwner.Id && l.Provider == identity.Provider, cancellationToken);
            if (!identity.IsDomainAuthority || hasLoginAtProvider)
            {
                return await DenyAsync(identity, SignInDenialReason.AccountConflict, cancellationToken);
            }

            if (emailOwner.IsDisabled)
            {
                return await DenyAsync(identity, SignInDenialReason.Disabled, cancellationToken);
            }

            user = emailOwner;
            db.UserLogins.Add(new UserLogin { UserId = user.Id, Provider = identity.Provider, Subject = identity.Subject, CreatedAt = now });
            audit.Record(AuditActions.LoginLinked, null, "user", user.Id, new { identity.Provider }, actorUserId: user.Id);
        }

        if (user is { IsDisabled: true })
        {
            return await DenyAsync(identity, SignInDenialReason.Disabled, cancellationToken);
        }

        var isBootstrapAdmin = options.Value.BootstrapAdminEmails.Contains(identity.Email);
        var invitations = await db.Invitations
            .Where(i => i.Email == identity.Email && i.AcceptedAt == null && i.ExpiresAt > now)
            .ToListAsync(cancellationToken);
        var domainOrganizationId = identity.VerifiedDomain is { Length: > 0 } hd
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
                Email = identity.Email,
                DisplayName = identity.Name ?? identity.Email,
                CreatedAt = now,
            };
            db.Users.Add(user);
            db.UserLogins.Add(new UserLogin { UserId = user.Id, Provider = identity.Provider, Subject = identity.Subject, CreatedAt = now });
        }

        user.Email = identity.Email;
        user.DisplayName = identity.Name ?? user.DisplayName;
        user.AvatarUrl = identity.Picture ?? user.AvatarUrl;
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
            audit.Record(AuditActions.MemberJoined, orgId, "user", user.Id, new { via = "domain", domain = identity.VerifiedDomain, provider = identity.Provider, role = defaultRole }, actorUserId: user.Id);
        }

        audit.Record(AuditActions.SignInSucceeded, null, "user", user.Id, null, actorUserId: user.Id);
        await db.SaveChangesAsync(cancellationToken);
        return new SignInDecision(user, null);
    }

    private async Task<SignInDecision> DenyAsync(ExternalIdentity identity, SignInDenialReason reason, CancellationToken cancellationToken)
    {
        audit.Record(AuditActions.SignInDenied, null, null, (string?)null, new { identity.Email, identity.Provider, reason = reason.ToString() }, actorUserId: null);
        await db.SaveChangesAsync(cancellationToken);
        return new SignInDecision(null, reason);
    }
}
