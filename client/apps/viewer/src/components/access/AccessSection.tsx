import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorText, SectionTitle } from "@/components/Layout";
import { type AccessRequest, api, GRANT_ROLES, type Role } from "@/lib/api";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";
import { AccessMapButton, type MapSubject } from "./AccessMap";
import { ROLE_HELP, RoleGuide } from "./RoleGuide";

type ResourceType = "project" | "feature" | "doc";

/**
 * Who has access to one item: the teams and people given a role on it, a form to add more (Managers only), and
 * "who can see this?", which lists every person who can reach it and why.
 */
export function AccessSection({
  orgId,
  resourceType,
  resourceId,
}: {
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
}) {
  const access = useQuery(queries.access(resourceType, resourceId));
  const people = useQuery(queries.accessPeople(resourceType, resourceId));
  const teams = useQuery(queries.orgTeams(orgId));
  const members = useQuery(queries.orgMembers(orgId));
  const { run, error } = useAction();
  const [principal, setPrincipal] = useState("");
  const [role, setRole] = useState<Role>("Viewer");

  const canManage = access.data?.canManage ?? false;
  const granted = new Set(access.data?.grants.map((g) => `${g.principalType.toLowerCase()}:${g.principalId}`));

  const set = (principalType: string, principalId: string, newRole: Role) =>
    run(() =>
      api.put("/api/access/{resourceType}/{resourceId}/{principalType}/{principalId}", {
        params: { path: { resourceType, resourceId, principalType, principalId } },
        body: { role: newRole },
      }),
    );
  const remove = (principalType: string, principalId: string) =>
    run(() =>
      api.delete("/api/access/{resourceType}/{resourceId}/{principalType}/{principalId}", {
        params: { path: { resourceType, resourceId, principalType, principalId } },
      }),
    );

  return (
    <div className="space-y-4">
      {canManage && <PendingRequests orgId={orgId} resourceType={resourceType} resourceId={resourceId} />}
      <RoleGuide />
      <ErrorText error={error ?? access.error ?? people.error} />

      {canManage && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const [type, id] = principal.split(":");
            if (type && id) void set(type, id, role).then((r) => r.ok && setPrincipal(""));
          }}
        >
          <NativeSelect
            aria-label="Team or person"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            required
          >
            <NativeSelectOption value="">Choose a team or person…</NativeSelectOption>
            <optgroup label="Teams">
              {teams.data
                ?.filter((t) => !granted.has(`team:${t.id}`))
                .map((t) => (
                  <NativeSelectOption key={t.id} value={`team:${t.id}`}>
                    {t.name} ({t.memberCount})
                  </NativeSelectOption>
                ))}
            </optgroup>
            <optgroup label="People">
              {members.data
                ?.filter((m) => m.role !== "Admin" && m.role !== "Owner" && !granted.has(`user:${m.userId}`))
                .map((m) => (
                  <NativeSelectOption key={m.userId} value={`user:${m.userId}`}>
                    {m.displayName} ({m.email})
                  </NativeSelectOption>
                ))}
            </optgroup>
          </NativeSelect>
          <NativeSelect aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {GRANT_ROLES.map((r) => (
              <NativeSelectOption key={r} value={r} title={ROLE_HELP[r]}>
                {r}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="submit">Give access</Button>
          {resourceType === "project" && (
            <AccessMapButton
              orgId={orgId}
              subject={toSubject(principal)}
              preview={{ addProjectId: resourceId, addRole: role }}
              title={`What giving ${role} would change`}
              label="Preview"
            />
          )}
        </form>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Team or person</TableHead>
            <TableHead>Role</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {access.data?.grants.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
                Nobody has been given access yet. Organisation Admins and Owners can still reach it.
              </TableCell>
            </TableRow>
          )}
          {access.data?.grants.map((g) => {
            const type = g.principalType.toLowerCase();
            return (
              <TableRow key={`${type}:${g.principalId}`}>
                <TableCell>
                  {g.principalType === "Team" && (
                    <Badge variant="outline" className="mr-2">
                      Team
                    </Badge>
                  )}
                  {g.name}
                  {g.email && <span className="ml-1 text-muted-foreground">({g.email})</span>}
                </TableCell>
                <TableCell>
                  {canManage ? (
                    <NativeSelect
                      size="sm"
                      aria-label={`Role for ${g.name}`}
                      value={g.role}
                      onChange={(e) => void set(type, g.principalId, e.target.value as Role)}
                    >
                      {GRANT_ROLES.map((r) => (
                        <NativeSelectOption key={r} value={r} title={ROLE_HELP[r]}>
                          {r}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : (
                    g.role
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {canManage && (
                    <Button variant="ghost" size="sm" onClick={() => void remove(type, g.principalId)}>
                      Remove
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <SectionTitle>Who can see this</SectionTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Person</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Why</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {people.data?.map((p) => (
            <TableRow key={p.userId}>
              <TableCell>
                {p.displayName} <span className="text-muted-foreground">({p.email})</span>
              </TableCell>
              <TableCell>{p.role}</TableCell>
              <TableCell className="text-muted-foreground">{p.via.join(" · ")}</TableCell>
              <TableCell className="text-right">
                {canManage && (
                  <AccessMapButton
                    orgId={orgId}
                    subject={{ type: "user", id: p.userId }}
                    label="Everything they can reach"
                  />
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Requests from people asking for access, for Managers to approve (with the role asked for, or another) or decline. */
function PendingRequests({
  orgId,
  resourceType,
  resourceId,
}: {
  orgId: string;
  resourceType: ResourceType;
  resourceId: string;
}) {
  const requests = useQuery(queries.accessRequests(resourceType, resourceId));
  const { run, error } = useAction();
  if (!requests.data?.length) return null;

  return (
    <div className="space-y-2 rounded-md border border-primary/40 p-3">
      <SectionTitle>
        {requests.data.length === 1 ? "1 person is" : `${requests.data.length} people are`} asking for access
      </SectionTitle>
      <ErrorText error={error} />
      {requests.data.map((r) => (
        <PendingRequest key={r.id} orgId={orgId} request={r} run={run} />
      ))}
    </div>
  );
}

function PendingRequest({
  orgId,
  request,
  run,
}: {
  orgId: string;
  request: AccessRequest;
  run: ReturnType<typeof useAction>["run"];
}) {
  const [role, setRole] = useState<Role>(request.role);
  const path = { params: { path: { requestId: request.id } } };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="min-w-48 flex-1">
        <span className="font-medium">{request.displayName}</span>{" "}
        <span className="text-muted-foreground">
          ({request.email}) asked to be {request.role}
          {request.currentRole && `, now ${request.currentRole}`}
        </span>
        {request.message && <span className="block text-muted-foreground">“{request.message}”</span>}
      </span>
      <NativeSelect
        size="sm"
        aria-label={`Role for ${request.displayName}`}
        value={role}
        onChange={(e) => setRole(e.target.value as Role)}
      >
        {GRANT_ROLES.map((r) => (
          <NativeSelectOption key={r} value={r} title={ROLE_HELP[r]}>
            {r}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <Button
        size="sm"
        onClick={() =>
          void run(() => api.post("/api/access/requests/{requestId}/approve", { ...path, body: { role } }))
        }
      >
        Approve
      </Button>
      <AccessMapButton
        orgId={orgId}
        subject={{ type: "user", id: request.userId }}
        preview={{ addProjectId: request.resourceId, addRole: role }}
        title={`What approving ${request.displayName} as ${role} would change`}
        label="Preview"
      />
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void run(() => api.post("/api/access/requests/{requestId}/decline", path))}
      >
        Decline
      </Button>
    </div>
  );
}

/** The `team:<id>` / `user:<id>` value of the "team or person" picker as a map subject, or null if nothing is picked. */
function toSubject(principal: string): MapSubject | null {
  const [type, id] = principal.split(":");
  return id && (type === "user" || type === "team") ? { type, id } : null;
}
