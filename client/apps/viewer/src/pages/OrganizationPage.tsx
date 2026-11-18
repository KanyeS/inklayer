import { useState, type FormEvent } from "react";
import { BookText } from "lucide-react";
import { useMe } from "@/App";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText, Loading, Page, PageTitle, SectionTitle } from "@/components/Layout";
import { LinkCards } from "@/components/LinkCards";
import { Badge } from "@inklayer/ui/components/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@inklayer/ui/components/breadcrumb";
import { Button } from "@inklayer/ui/components/button";
import { Empty, EmptyHeader, EmptyTitle } from "@inklayer/ui/components/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@inklayer/ui/components/tabs";
import { ROLES, atLeast, del, get, patch, post, put, type Invitation, type Member, type Organization, type Project, type Role } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { Link, navigate } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";

export function OrganizationPage({ orgId }: { orgId: string }) {
  const org = useAsync(() => get<Organization>(`/api/orgs/${orgId}`), [orgId]);
  const projects = useAsync(() => get<Project[]>(`/api/orgs/${orgId}/projects`), [orgId]);

  if (org.error) return <Page><ErrorText error={org.error} /></Page>;
  if (!org.data) return <Page><Loading /></Page>;
  const isAdmin = atLeast(org.data.myRole, "Admin");

  return (
    <Page>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem><BreadcrumbLink render={<Link to="/" />}>Organisations</BreadcrumbLink></BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{org.data.name}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageTitle badge={<Badge variant="secondary">{org.data.myRole}</Badge>}>{org.data.name}</PageTitle>
        <Button variant="outline" nativeButton={false} render={<Link to={`/orgs/${orgId}/docs`} />}><BookText data-icon="inline-start" />Docs</Button>
      </div>
      <Tabs defaultValue="projects">
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="projects">Projects</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          {isAdmin && <TabsTrigger value="settings">Settings</TabsTrigger>}
        </TabsList>
        <TabsContent value="projects" className="space-y-4">
          {isAdmin && <CreateProject orgId={orgId} />}
          <ErrorText error={projects.error} />
          {projects.data?.length === 0 && (
            <Empty className="border"><EmptyHeader><EmptyTitle>No projects yet</EmptyTitle></EmptyHeader></Empty>
          )}
          {projects.data && (
            <LinkCards items={projects.data.map((p) => ({ key: p.id, to: `/projects/${p.id}`, title: p.name, badge: p.myRole }))} />
          )}
        </TabsContent>
        <TabsContent value="members"><Members org={org.data} /></TabsContent>
        {isAdmin && <TabsContent value="settings"><Settings org={org.data} onSaved={org.reload} /></TabsContent>}
      </Tabs>
    </Page>
  );
}

function CreateProject({ orgId }: { orgId: string }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const project = await post<Project>(`/api/orgs/${orgId}/projects`, { name });
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
      <Input className="w-64" aria-label="New project name" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      <Button type="submit">Create project</Button>
      <ErrorText error={error} />
    </form>
  );
}

function Members({ org }: { org: Organization }) {
  const { me } = useMe();
  const isAdmin = atLeast(org.myRole, "Admin");
  const isOwner = org.myRole === "Owner";
  const members = useAsync(() => get<Member[]>(`/api/orgs/${org.id}/members`), [org.id]);
  const invitations = useAsync(() => (isAdmin ? get<Invitation[]>(`/api/orgs/${org.id}/invitations`) : Promise.resolve([])), [org.id, isAdmin]);
  const [error, setError] = useState<Error | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("Commenter");

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await Promise.all([members.reload(), invitations.reload()]);
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    }
  };
  const assignable = ROLES.filter((r) => isOwner || r !== "Owner");
  const remove = async (m: Member) => {
    const ok = await act(() => del(`/api/orgs/${org.id}/members/${m.userId}`));
    if (ok && m.userId === me.id) window.location.href = "/";
  };

  return (
    <div className="space-y-4">
      <ErrorText error={error ?? members.error} />
      {isAdmin && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void act(async () => { await post(`/api/orgs/${org.id}/invitations`, { email, role }); setEmail(""); }); }}>
          <Input className="w-64" type="email" aria-label="Email" placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <NativeSelect aria-label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {assignable.map((r) => <NativeSelectOption key={r}>{r}</NativeSelectOption>)}
          </NativeSelect>
          <Button type="submit">Invite</Button>
          <span className="text-xs text-muted-foreground">They join when they next sign in with this address.</span>
        </form>
      )}
      <Table>
        <TableHeader>
          <TableRow><TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead /></TableRow>
        </TableHeader>
        <TableBody>
          {members.data?.map((m) => {
            const canManage = isAdmin && (isOwner || m.role !== "Owner");
            const isMe = m.userId === me.id;
            return (
              <TableRow key={m.userId}>
                <TableCell>{m.displayName}</TableCell>
                <TableCell className="text-muted-foreground">{m.email}</TableCell>
                <TableCell>
                  {canManage ? (
                    <NativeSelect size="sm" aria-label={`Role for ${m.displayName}`} value={m.role} onChange={(e) => void act(() => put(`/api/orgs/${org.id}/members/${m.userId}`, { role: e.target.value }))}>
                      {assignable.map((r) => <NativeSelectOption key={r}>{r}</NativeSelectOption>)}
                    </NativeSelect>
                  ) : m.role}
                </TableCell>
                <TableCell className="text-right">
                  {(isMe || canManage) && (
                    <ConfirmButton
                      title={isMe ? "Leave this organisation?" : `Remove ${m.displayName}?`}
                      confirmLabel={isMe ? "Leave" : "Remove"}
                      onConfirm={() => void remove(m)}
                    >{isMe ? "Leave" : "Remove"}</ConfirmButton>
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
                    <Button variant="destructive" size="sm" onClick={() => void act(() => del(`/api/orgs/${org.id}/invitations/${i.id}`))}>Revoke</Button>
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

function Settings({ org, onSaved }: { org: Organization; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(org.name);
  const [domains, setDomains] = useState(org.allowedDomains.join(", "));
  const [defaultRole, setDefaultRole] = useState<Role>(org.defaultRole);
  const [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await patch(`/api/orgs/${org.id}`, { name, defaultRole, allowedDomains: domains.split(/[\s,]+/).filter(Boolean) });
      await onSaved();
      setSaved(true);
    } catch (err) {
      setError(err as Error);
    }
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
          <Input id="org-domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="acme.com, acme.co.uk" />
          <FieldDescription>Google Workspace, or a domain your SSO provider is verified for.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="org-default-role">Role for people who join through a domain</FieldLabel>
          <NativeSelect id="org-default-role" value={defaultRole} onChange={(e) => setDefaultRole(e.target.value as Role)}>
            {(["Viewer", "Commenter", "Editor"] as Role[]).map((r) => <NativeSelectOption key={r}>{r}</NativeSelectOption>)}
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
