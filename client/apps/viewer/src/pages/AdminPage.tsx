import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { type FormEvent, useState } from "react";
import { useMe } from "@/App";
import { ConfirmButton } from "@/components/ConfirmButton";
import { EmailSetupSection } from "@/components/EmailSetupSection";
import { FeaturesSection } from "@/components/FeaturesSection";
import { ErrorText, Page, PageTitle, SectionTitle } from "@/components/Layout";
import { NetworkAccessSection } from "@/components/NetworkAccessSection";
import { AdminSharesSection } from "@/components/Shares";
import { type AdminUser, api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { navigate } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";

export function AdminPage() {
  const { me, reloadMe } = useMe();
  const users = useAsync(() => api.get("/api/admin/users"), []);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [error, setError] = useState<Error | null>(null);

  if (!me.isSystemAdmin)
    return (
      <Page>
        <p className="text-destructive">Instance administrators only.</p>
      </Page>
    );

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const org = await api.post("/api/orgs", {
        body: { name, allowedDomains: domains.split(/[\s,]+/).filter(Boolean) },
      });
      await reloadMe();
      navigate(`/orgs/${org.id}`);
    } catch (err) {
      setError(err as Error);
    }
  };
  const setDisabled = async (user: AdminUser, disabled: boolean) => {
    try {
      const path = { params: { path: { userId: user.id } } };
      await (disabled
        ? api.post("/api/admin/users/{userId}/disable", path)
        : api.post("/api/admin/users/{userId}/enable", path));
      await users.reload();
    } catch (err) {
      setError(err as Error);
    }
  };

  return (
    <Page>
      <PageTitle>Administration</PageTitle>
      <SectionTitle>New organisation</SectionTitle>
      <form className="max-w-md" onSubmit={create}>
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
              placeholder="acme.com"
            />
            <FieldDescription>
              Optional. Google Workspace, or a domain your SSO provider is verified for.
            </FieldDescription>
          </Field>
          <div>
            <Button type="submit">Create organisation</Button>
          </div>
        </FieldGroup>
      </form>
      <div className="mt-4">
        <ErrorText error={error ?? users.error} />
      </div>
      <FeaturesSection />
      <EmailSetupSection />
      <NetworkAccessSection />
      {me.features.sharing && (
        <>
          <SectionTitle>Shared links</SectionTitle>
          <AdminSharesSection />
        </>
      )}
      <SectionTitle>Users</SectionTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Last sign-in</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.data?.map((u) => (
            <TableRow key={u.id} className={u.isDisabled ? "opacity-50" : undefined}>
              <TableCell>
                <span className="flex items-center gap-2">
                  {u.preferredName ? (
                    <>
                      {u.preferredName} <span className="text-muted-foreground">({u.displayName})</span>
                    </>
                  ) : (
                    u.displayName
                  )}
                  {u.isSystemAdmin && <Badge variant="secondary">Admin</Badge>}
                  {u.isDisabled && <Badge variant="outline">Disabled</Badge>}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground">{u.email}</TableCell>
              <TableCell className="text-muted-foreground">{timeAgo(u.lastSignInAt)}</TableCell>
              <TableCell className="text-right">
                {u.id !== me.id &&
                  (u.isDisabled ? (
                    <Button variant="outline" size="sm" onClick={() => void setDisabled(u, false)}>
                      Enable
                    </Button>
                  ) : (
                    <ConfirmButton
                      title={`Disable ${u.email}?`}
                      description="They are signed out everywhere immediately."
                      confirmLabel="Disable"
                      onConfirm={() => void setDisabled(u, true)}
                    >
                      Disable
                    </ConfirmButton>
                  ))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Page>
  );
}
