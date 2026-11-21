using Inklayer.Api.Access;
using Inklayer.Domain.Authorization;
using Inklayer.Infrastructure.Persistence;
using Microsoft.EntityFrameworkCore;

namespace Inklayer.Api.Features.Access;

/// <summary>What a node in an access map is.</summary>
public enum AccessMapNodeKind
{
    Person,
    Team,

    /// <summary>A grant given to the person directly, not through a team.</summary>
    Direct,

    /// <summary>The person is an organisation Admin or Owner, which reaches every product.</summary>
    Organisation,
    Product,
}

/// <summary>What a previewed change does to a node or edge.</summary>
public enum AccessMapChange
{
    /// <summary>New: no access before.</summary>
    Added,

    /// <summary>Access was there, and the role goes up.</summary>
    Raised,
}

/// <param name="Id">Stable within the map, e.g. <c>user:{id}</c>, <c>team:{id}</c>, <c>project:{id}</c>.</param>
/// <param name="Column">Left to right: who → how → what. Later levels (features, docs) get further columns.</param>
/// <param name="EntityId">The person, team or product, for drilling in or linking.</param>
/// <param name="Role">For products: the effective role (after the previewed change, if any). For people: their organisation role.</param>
/// <param name="PreviousRole">For products whose role a preview changes: the role before it (null if they had no access).</param>
public sealed record AccessMapNode(
    string Id, AccessMapNodeKind Kind, int Column, string Label, string? Detail, Guid? EntityId, Role? Role,
    Role? PreviousRole = null, AccessMapChange? Change = null);

/// <param name="Role">The role this route gives, on edges into a product.</param>
public sealed record AccessMapEdge(string From, string To, Role? Role, AccessMapChange? Change = null);

/// <param name="SubjectId">The node the map is about.</param>
/// <param name="HiddenProducts">Products the subject reaches that the caller can't see, so they're only counted.</param>
public sealed record AccessMapResponse(string SubjectId, IReadOnlyList<AccessMapNode> Nodes, IReadOnlyList<AccessMapEdge> Edges, int HiddenProducts);

/// <summary>
/// "What can this person or team reach, and how?" as a left-to-right flow: who → through what (directly, a team, being an
/// Admin) → which products, with roles. It can preview a change before it's made (giving a role on a product, or adding a
/// person to a team) and marks what the change adds or raises.
/// <para>Organisation Admins see everything. A product's Managers can look too, but only at the products they can see;
/// the rest are counted, not named with roles. Everyone else gets 403.</para>
/// </summary>
internal static class AccessMapEndpoints
{
    public static IEndpointRouteBuilder MapAccessMapEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/orgs/{orgId:guid}/access-map/{principalType}/{principalId:guid}", GetAsync)
            .WithTags("Access").RequireAuthorization()
            .Produces<AccessMapResponse>()
            .WithSummary("What a person or team can reach and how; ?addProjectId=&addRole= or ?addTeamId= previews a change");
        return app;
    }

    private static async Task<IResult> GetAsync(
        Guid orgId, string principalType, Guid principalId, Guid? addProjectId, Role? addRole, Guid? addTeamId,
        AccessService access, InklayerDbContext db, CancellationToken ct)
    {
        if (!Enum.TryParse<AccessPrincipalType>(principalType, ignoreCase: true, out var kind) || !Enum.IsDefined(kind))
        {
            return TypedResults.NotFound();
        }

        // The caller: an Admin sees everything; a Manager of any product sees the products they can see.
        var caller = await access.GetCallerAsync(orgId, ct);
        if (caller.OrganizationRole is null)
        {
            return TypedResults.NotFound();
        }

        var callerRoles = await access.GetProjectRolesAsync(orgId, ct);
        var callerIsAdmin = caller.OrganizationRole >= Role.Admin;
        if (!callerIsAdmin && !callerRoles.Values.Any(r => r >= Role.Manager))
        {
            return TypedResults.Problem(statusCode: StatusCodes.Status403Forbidden, title: "Only Admins and product Managers can see access maps.");
        }

        if ((addProjectId is null) != (addRole is null) || (addRole is { } r && !PermissionPolicy.IsGrantable(r)))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["addRole"] = ["Preview a grant with both addProjectId and addRole (Viewer, Commenter, Editor or Manager)."] });
        }

        var products = await db.Projects.AsNoTracking().Where(p => p.OrganizationId == orgId && !p.IsArchived).ToDictionaryAsync(p => p.Id, p => p.Name, ct);
        var teams = await db.Teams.AsNoTracking().Where(t => t.OrganizationId == orgId).ToDictionaryAsync(t => t.Id, t => t.Name, ct);
        var grants = await db.AccessGrants.AsNoTracking()
            .Where(g => g.OrganizationId == orgId && g.ResourceType == AccessResourceType.Project)
            .ToListAsync(ct);
        if (addProjectId is { } p && !products.ContainsKey(p) || addTeamId is { } t && !teams.ContainsKey(t))
        {
            return TypedResults.NotFound();
        }

        var map = new MapBuilder(products, callerIsAdmin ? null : callerRoles.Keys.ToHashSet());
        if (kind == AccessPrincipalType.User)
        {
            var person = await db.OrganizationMembers.AsNoTracking()
                .Where(m => m.OrganizationId == orgId && m.UserId == principalId)
                .Select(m => new { m.Role, m.User!.Email, Name = m.User.PreferredName ?? m.User.DisplayName })
                .SingleOrDefaultAsync(ct);
            if (person is null)
            {
                return TypedResults.NotFound();
            }

            var teamIds = await db.TeamMembers.AsNoTracking()
                .Where(m => m.UserId == principalId && teams.Keys.Contains(m.TeamId))
                .Select(m => m.TeamId)
                .ToListAsync(ct);
            map.Person(principalId, person.Name, person.Email, person.Role, teamIds, teams, grants, addProjectId, addRole, addTeamId);
        }
        else
        {
            if (!teams.TryGetValue(principalId, out var teamName))
            {
                return TypedResults.NotFound();
            }

            var members = await db.TeamMembers.AsNoTracking()
                .Where(m => m.TeamId == principalId)
                .Select(m => new MapBuilder.Member(m.UserId, m.User!.PreferredName ?? m.User.DisplayName, m.User.Email))
                .ToListAsync(ct);
            map.Team(principalId, teamName, members, grants, addProjectId, addRole);
        }

        return TypedResults.Ok(map.Build());
    }

    /// <summary>Builds the map from loaded data. Effective roles come from <see cref="AccessPolicy"/>, before and after the preview.</summary>
    private sealed class MapBuilder(IReadOnlyDictionary<Guid, string> products, IReadOnlySet<Guid>? visibleToCaller)
    {
        public sealed record Member(Guid UserId, string Name, string Email);

        private readonly List<AccessMapNode> _nodes = [];
        private readonly List<AccessMapEdge> _edges = [];
        private readonly HashSet<Guid> _hidden = [];
        private string _subject = "";

        public AccessMapResponse Build() => new(_subject, _nodes, _edges, _hidden.Count);

        public void Person(
            Guid userId, string name, string email, Role orgRole, IReadOnlyList<Guid> teamIds, IReadOnlyDictionary<Guid, string> teams,
            IReadOnlyList<AccessGrant> grants, Guid? addProjectId, Role? addRole, Guid? addTeamId)
        {
            _subject = $"user:{userId}";
            _nodes.Add(new AccessMapNode(_subject, AccessMapNodeKind.Person, 0, name, email, userId, orgRole));

            // Each route to products: (node id, grants it gives, whether it only exists in the preview).
            var routes = new List<(string Id, List<Give> Gives, bool New)>();
            if (orgRole >= Role.Admin)
            {
                _nodes.Add(new AccessMapNode("org", AccessMapNodeKind.Organisation, 1, $"Organisation {orgRole}", "Reaches every product", null, orgRole));
                routes.Add(("org", [.. products.Keys.Select(p => new Give("org", p, orgRole))], false));
            }

            var direct = WithPreview("direct", grants.Where(g => g.PrincipalType == AccessPrincipalType.User && g.PrincipalId == userId), addProjectId, addRole);
            if (direct.Count > 0)
            {
                var isNew = direct.All(d => !d.Before);
                _nodes.Add(new AccessMapNode("direct", AccessMapNodeKind.Direct, 1, "Given directly", null, null, null, Change: isNew ? AccessMapChange.Added : null));
                routes.Add(("direct", direct, isNew));
            }

            foreach (var (teamId, isNew) in teamIds.Select(t => (t, false)).Concat(addTeamId is { } added && !teamIds.Contains(added) ? [(added, true)] : []))
            {
                var id = $"team:{teamId}";
                _nodes.Add(new AccessMapNode(id, AccessMapNodeKind.Team, 1, teams[teamId], null, teamId, null, Change: isNew ? AccessMapChange.Added : null));
                routes.Add((id, [.. grants.Where(g => g.PrincipalType == AccessPrincipalType.Team && g.PrincipalId == teamId)
                    .Select(g => new Give(id, g.ResourceId, g.Role, Before: !isNew))], isNew));
            }

            foreach (var route in routes)
            {
                _edges.Add(new AccessMapEdge(_subject, route.Id, null, route.New ? AccessMapChange.Added : null));
            }

            AddProducts(orgRole, [.. routes.SelectMany(r => r.Gives)]);
        }

        public void Team(Guid teamId, string teamName, IReadOnlyList<Member> members, IReadOnlyList<AccessGrant> grants, Guid? addProjectId, Role? addRole)
        {
            _subject = $"team:{teamId}";
            foreach (var member in members.OrderBy(m => m.Name, StringComparer.OrdinalIgnoreCase))
            {
                var id = $"user:{member.UserId}";
                _nodes.Add(new AccessMapNode(id, AccessMapNodeKind.Person, 0, member.Name, member.Email, member.UserId, null));
                _edges.Add(new AccessMapEdge(id, _subject, null));
            }

            _nodes.Add(new AccessMapNode(_subject, AccessMapNodeKind.Team, 1, teamName, $"{members.Count} {(members.Count == 1 ? "person" : "people")}", teamId, null));
            var gives = WithPreview(_subject, grants.Where(g => g.PrincipalType == AccessPrincipalType.Team && g.PrincipalId == teamId), addProjectId, addRole);

            // A team's own reach, as if someone had only this team: organisation role doesn't apply.
            AddProducts(Role.Viewer, gives);
        }

        /// <summary>A role a route gives on a product: before the previewed change, after it, or both.</summary>
        private sealed record Give(string Route, Guid Product, Role Role, bool Before = true, bool After = true);

        /// <summary>A principal's grants, with the previewed grant replacing theirs on that product (as giving a role does).</summary>
        private static List<Give> WithPreview(string route, IEnumerable<AccessGrant> grants, Guid? addProjectId, Role? addRole)
        {
            var gives = grants.Select(g => new Give(route, g.ResourceId, g.Role, After: g.ResourceId != addProjectId)).ToList();
            if (addProjectId is { } project && addRole is { } role)
            {
                gives.Add(new Give(route, project, role, Before: false));
            }

            return gives;
        }

        /// <summary>Adds product nodes with the effective role before and after the preview, and an edge from each route.</summary>
        private void AddProducts(Role orgRole, IReadOnlyList<Give> gives)
        {
            foreach (var group in gives.GroupBy(g => g.Product).OrderBy(g => products.GetValueOrDefault(g.Key, ""), StringComparer.OrdinalIgnoreCase))
            {
                if (!products.TryGetValue(group.Key, out var name))
                {
                    continue; // archived
                }

                if (visibleToCaller is not null && !visibleToCaller.Contains(group.Key))
                {
                    _hidden.Add(group.Key);
                    continue;
                }

                var before = AccessPolicy.Resolve(orgRole, [new AccessLevel([.. group.Where(g => g.Before).Select(g => g.Role)])]);
                var after = AccessPolicy.Resolve(orgRole, [new AccessLevel([.. group.Where(g => g.After).Select(g => g.Role)])]);
                if (after is null)
                {
                    continue;
                }

                AccessMapChange? change = before is null ? AccessMapChange.Added : after > before ? AccessMapChange.Raised : null;
                var id = $"project:{group.Key}";
                _nodes.Add(new AccessMapNode(id, AccessMapNodeKind.Product, 2, name, null, group.Key, after, change is null ? null : before, change));
                foreach (var g in group.Where(g => g.After))
                {
                    _edges.Add(new AccessMapEdge(g.Route, id, g.Role, g.Before ? null : AccessMapChange.Added));
                }
            }
        }
    }
}
