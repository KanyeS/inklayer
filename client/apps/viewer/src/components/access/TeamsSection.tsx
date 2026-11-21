import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@inklayer/ui/components/empty";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Table, TableBody, TableCell, TableRow } from "@inklayer/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText } from "@/components/Layout";
import { api, type Team } from "@/lib/api";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";
import { AccessMapButton } from "./AccessMap";

const SOURCE_LABEL: Record<Team["source"], string> = {
  Manual: "",
  Claim: "Synced from sign-in",
  Scim: "Synced by SCIM",
};

/**
 * An organisation's teams, such as Payments or Support. Teams are given access to products and are who docs are written
 * for. Everyone sees the list; Admins create teams and choose who's in them.
 */
/** `canSeeMaps`: the caller is an Admin or a product Manager, who can see what teams and people can reach. */
export function TeamsSection({ orgId, isAdmin, canSeeMaps }: { orgId: string; isAdmin: boolean; canSeeMaps: boolean }) {
  const teams = useQuery(queries.orgTeams(orgId));
  const [name, setName] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const { run, error } = useAction();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const done = await run(() => api.post("/api/orgs/{orgId}/teams", { params: { path: { orgId } }, body: { name } }));
    if (done.ok) {
      setName("");
      setOpen(done.value.id);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        Teams group people by what they work on or what they do, such as Payments or Support. Give a team access to a
        product, and everyone in it gets that access.
      </p>
      {isAdmin && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={create}>
          <Input
            className="w-64"
            aria-label="New team name"
            placeholder="New team name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
          />
          <Button type="submit">Create team</Button>
        </form>
      )}
      <ErrorText error={error ?? teams.error} />
      {teams.data?.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No teams yet</EmptyTitle>
            <EmptyDescription>Until there are teams, give people access to products one by one.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <div className="space-y-2">
        {teams.data?.map((t) => (
          <div key={t.id} className="rounded-md border">
            <button
              type="button"
              className="flex w-full items-center gap-2 p-3 text-left"
              aria-expanded={open === t.id}
              onClick={() => setOpen(open === t.id ? null : t.id)}
            >
              <span className="font-medium">{t.name}</span>
              <span className="text-sm text-muted-foreground">
                {t.memberCount} {t.memberCount === 1 ? "person" : "people"}
              </span>
              {t.isMember && <Badge variant="secondary">You</Badge>}
              {SOURCE_LABEL[t.source] && <Badge variant="outline">{SOURCE_LABEL[t.source]}</Badge>}
            </button>
            {open === t.id && <TeamDetail orgId={orgId} team={t} isAdmin={isAdmin} canSeeMaps={canSeeMaps} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function TeamDetail({
  orgId,
  team,
  isAdmin,
  canSeeMaps,
}: {
  orgId: string;
  team: Team;
  isAdmin: boolean;
  canSeeMaps: boolean;
}) {
  const members = useQuery(queries.teamMembers(team.id));
  const orgMembers = useQuery({ ...queries.orgMembers(orgId), enabled: isAdmin });
  const [adding, setAdding] = useState("");
  const { run, error } = useAction();
  const editable = isAdmin && team.source === "Manual";
  const inTeam = new Set(members.data?.map((m) => m.userId));
  const path = (userId: string) => ({ params: { path: { teamId: team.id, userId } } });

  return (
    <div className="space-y-3 border-t p-3">
      <ErrorText error={error ?? members.error} />
      {canSeeMaps && (
        <AccessMapButton
          orgId={orgId}
          subject={{ type: "team", id: team.id }}
          title={`What ${team.name} can reach`}
          label="Access map"
        />
      )}
      {!editable && team.source !== "Manual" && (
        <p className="text-sm text-muted-foreground">Who's in this team comes from your identity provider.</p>
      )}
      {editable && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (adding)
              void run(() => api.put("/api/teams/{teamId}/members/{userId}", path(adding))).then(() => setAdding(""));
          }}
        >
          <NativeSelect aria-label="Add a person" value={adding} onChange={(e) => setAdding(e.target.value)} required>
            <NativeSelectOption value="">Add a person…</NativeSelectOption>
            {orgMembers.data
              ?.filter((m) => !inTeam.has(m.userId))
              .map((m) => (
                <NativeSelectOption key={m.userId} value={m.userId}>
                  {m.displayName} ({m.email})
                </NativeSelectOption>
              ))}
          </NativeSelect>
          <Button type="submit" size="sm">
            Add
          </Button>
          <AccessMapButton
            orgId={orgId}
            subject={adding ? { type: "user", id: adding } : null}
            preview={{ addTeamId: team.id }}
            title={`What joining ${team.name} would give them`}
            label="Preview"
          />
        </form>
      )}
      <Table>
        <TableBody>
          {members.data?.map((m) => (
            <TableRow key={m.userId}>
              <TableCell>{m.displayName}</TableCell>
              <TableCell className="text-muted-foreground">{m.email}</TableCell>
              <TableCell className="space-x-2 text-right">
                {canSeeMaps && (
                  <AccessMapButton orgId={orgId} subject={{ type: "user", id: m.userId }} label="Access" />
                )}
                {editable && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void run(() => api.delete("/api/teams/{teamId}/members/{userId}", path(m.userId)))}
                  >
                    Remove
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {isAdmin && (
        <ConfirmButton
          title={`Delete ${team.name}?`}
          description="Everyone in it loses the access the team gave them."
          confirmLabel="Delete team"
          onConfirm={() => void run(() => api.delete("/api/teams/{teamId}", { params: { path: { teamId: team.id } } }))}
        >
          Delete team
        </ConfirmButton>
      )}
    </div>
  );
}
