import { Badge } from "@inklayer/ui/components/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@inklayer/ui/components/breadcrumb";
import { Button } from "@inklayer/ui/components/button";
import { Empty, EmptyHeader, EmptyTitle } from "@inklayer/ui/components/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@inklayer/ui/components/tabs";
import { useQuery } from "@tanstack/react-query";
import { BookText } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useMe } from "@/App";
import { AccessMapButton } from "@/components/access/AccessMap";
import { TeamsSection } from "@/components/access/TeamsSection";
import { ConfirmButton } from "@/components/ConfirmButton";
import { IntegrationsSection } from "@/components/IntegrationsSection";
import { ErrorText, Loading, Page, PageTitle, SectionTitle } from "@/components/Layout";
import { LinkCards } from "@/components/LinkCards";
import { api, atLeast, type Member, ORG_ROLES, type Organization, type Role } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { personTitle } from "@/lib/people";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";
import { Link, navigate } from "@/lib/router";

export function OrganizationPage({ orgId }: { orgId: string }) {
  const { me } = useMe();
  const org = useQuery(queries.org(orgId));
  const projects = useQuery(queries.orgProjects(orgId));

  if (org.error)
    return (
      <Page>
        <ErrorText error={org.error} />
      </Page>
    );
  if (!org.data)
    return (
      <Page>
        <Loading />
      </Page>
    );
  const isAdmin = atLeast(org.data.myRole, "Admin");
  // Admins and product Managers can see what people and teams can reach.
  const canSeeMaps = isAdmin || (projects.data?.some((p) => p.myRole === "Manager") ?? false);

  return (
    <Page>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/" />}>Organisations</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{org.data.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle badge={<Badge variant="secondary">{org.data.myRole}</Badge>}>{org.data.name}</PageTitle>
        {me.features.docs && (
          <Button variant="outline" nativeButton={false} render={<Link to={`/orgs/${orgId}/docs`} />}>
            <BookText data-icon="inline-start" />
            Docs
          </Button>
        )}
      </div>
      <Tabs defaultValue="projects">
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="projects">Products</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="teams">Teams</TabsTrigger>
          {isAdmin && <TabsTrigger value="integrations">Integrations</TabsTrigger>}
          {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
        <TabsContent value="projects" className="space-y-4">
          {isAdmin && <CreateProject orgId={orgId} />}
          <ErrorText error={projects.error} />
          {projects.data?.length === 0 && (
            <Empty className="border">
              <EmptyHeader>
                <EmptyTitle>No products yet</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
          {projects.data && (
            <LinkCards
              items={projects.data.map((p) => ({
                key: p.id,
                to: `/projects/${p.id}`,
                title: p.name,
                badge: p.myRole ?? (p.accessRequested ? "Requested" : "No access"),
              }))}
            />
          )}
        </TabsContent>
        <TabsContent value="members">
          <Members org={org.data} canSeeMaps={canSeeMaps} />
        </TabsContent>
        <TabsContent value="teams">
          <TeamsSection orgId={orgId} isAdmin={isAdmin} canSeeMaps={canSeeMaps} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="integrations">
            <IntegrationsSection orgId={orgId} />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="settings">
            <Settings org={org.data} />
          </TabsContent>
        )}
      </Tabs>
    </Page>
  );
}

function CreateProject({ orgId }: { orgId: string }) {
  const [name, setName] = useState("");
  const { run, error } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const project = await run(() =>
      api.post("/api/orgs/{orgId}/projects", { params: { path: { orgId } }, body: { name } }),
    );
    if (project.ok) navigate(`/projects/${project.value.id}`);
  };
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
      <Input
        className="w-64"
        aria-label="New product name"
        placeholder="New product name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={200}
      />
      <Button type="submit">Create product</Button>
      <ErrorText error={error} />
    </form>
  );
}

function Members({ org, canSeeMaps }: { org: Organization; canSeeMaps: boolean }) {
  const { me } = useMe();
  const isAdmin = atLeast(org.myRole, "Admin");
  const isOwner = org.myRole === "Owner";
  const members = useQuery(queries.orgMembers(org.id));
  // Only admins may list invitations.
  const invitations = useQuery({ ...queries.orgInvitations(org.id), enabled: isAdmin });
  const { run, error } = useAction();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("Commenter");

  const act = async (fn: () => Promise<unknown>) => (await run(fn)).ok;
  const assignable = ORG_ROLES.filter((r) => isOwner || r !== "Owner");
  const remove = async (m: Member) => {
    const ok = await act(() =>
      api.delete("/api/orgs/{orgId}/members/{userId}", { params: { path: { orgId: org.id, userId: m.userId } } }),
    );
    if (ok && m.userId === me.id) window.location.href = "/";
  };

  return (
    <div className="space-y-4">
      <ErrorText error={error ?? members.error} />
      {isAdmin && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.post("/api/orgs/{orgId}/invitations", {
                params: { path: { orgId: org.id } },
                body: { email, role },
              });
              setEmail("");
            });
          }}
        >
          <Input
            className="w-64"
            type="email"
            aria-label="Email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <NativeSelect aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {assignable.map((r) => (
              <NativeSelectOption key={r}>{r}</NativeSelectOption>
            ))}
          </NativeSelect>
          <Button type="submit">Invite</Button>
          <span className="text-xs text-muted-foreground">They join when they next sign in with this address.</span>
        </form>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Role</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.data?.map((m) => {
            const canManage = isAdmin && (isOwner || m.role !== "Owner");
            const isMe = m.userId === me.id;
            return (
              <TableRow key={m.userId}>
                <TableCell title={personTitle(m)}>
                  {m.displayName}
                  {m.fullName && m.fullName !== m.displayName && (
                    <span className="ml-1 text-muted-foreground">({m.fullName})</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{m.email}</TableCell>
                <TableCell>
                  {canManage ? (
                    <NativeSelect
                      size="sm"
                      aria-label={`Role for ${m.displayName}`}
                      value={m.role}
                      onChange={(e) =>
                        void act(() =>
                          api.put("/api/orgs/{orgId}/members/{userId}", {
                            params: { path: { orgId: org.id, userId: m.userId } },
                            body: { role: e.target.value as Role },
                          }),
                        )
                      }
                    >
                      {assignable.map((r) => (
                        <NativeSelectOption key={r}>{r}</NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : (
                    m.role
                  )}
                </TableCell>
                <TableCell className="space-x-2 text-right">
                  {canSeeMaps && (
                    <AccessMapButton orgId={org.id} subject={{ type: "user", id: m.userId }} label="Access" />
                  )}
                  {(isMe || canManage) && (
                    <ConfirmButton
                      title={isMe ? "Leave this organisation?" : `Remove ${m.displayName}?`}
                      confirmLabel={isMe ? "Leave" : "Remove"}
                      onConfirm={() => void remove(m)}
                    >
                      {isMe ? "Leave" : "Remove"}
                    </ConfirmButton>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {isAdmin && invitations.data && invitations.data.length > 0 && (
        <>
          <SectionTitle>Pending invitations</SectionTitle>
          <Table>
            <TableBody>
              {invitations.data.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.email}</TableCell>
                  <TableCell>{i.role}</TableCell>
                  <TableCell className="text-muted-foreground">expires {dateTime(i.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() =>
                        void act(() =>
                          api.delete("/api/orgs/{orgId}/invitations/{invitationId}", {
                            params: { path: { orgId: org.id, invitationId: i.id } },
                          }),
                        )
                      }
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </div>
  );
}

function Settings({ org }: { org: Organization }) {
  const [name, setName] = useState(org.name);
  const [domains, setDomains] = useState(org.allowedDomains.join(", "));
  const [defaultRole, setDefaultRole] = useState<Role>(org.defaultRole);
  const [saved, setSaved] = useState(false);
  const { run, error } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    const done = await run(() =>
      api.patch("/api/orgs/{orgId}", {
        params: { path: { orgId: org.id } },
        body: { name, defaultRole, allowedDomains: domains.split(/[\s,]+/).filter(Boolean) },
      }),
    );
    setSaved(done.ok);
  };
  return (
    <form className="max-w-md" onSubmit={submit}>
      <FieldGroup className="gap-5">
        <Field>
          <FieldLabel htmlFor="org-name">Name</FieldLabel>
          <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <Field>
          <FieldLabel htmlFor="org-domains">Email domains that join automatically</FieldLabel>
          <Input
            id="org-domains"
            value={domains}
            onChange={(e) => setDomains(e.target.value)}
            placeholder="acme.com, acme.co.uk"
          />
          <FieldDescription>Google Workspace, or a domain your SSO provider is verified for.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="org-default-role">Role for people who join through a domain</FieldLabel>
          <NativeSelect
            id="org-default-role"
            value={defaultRole}
            onChange={(e) => setDefaultRole(e.target.value as Role)}
          >
            {(["Viewer", "Commenter", "Editor"] as Role[]).map((r) => (
              <NativeSelectOption key={r}>{r}</NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit">Save</Button>
          {saved && <span className="text-sm text-muted-foreground">Saved.</span>}
        </div>
        <ErrorText error={error} />
      </FieldGroup>
    </form>
  );
}
