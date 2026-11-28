import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@inklayer/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { CopyIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { GuideLink, type GuideSection } from "@/components/GuideLink";
import { ErrorText, Loading, SectionTitle } from "@/components/Layout";
import { api, type TrackerApp } from "@/lib/api";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";

type Kind = TrackerApp["kind"];

/** Where to register each tracker's app, what its instance box means, and its part of the setup guide. */
const TRACKERS: Record<
  Kind,
  { where: string; instance?: { label: string; placeholder: string }; guide: GuideSection }
> = {
  github: {
    where: "GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.",
    instance: { label: "GitHub Enterprise Server address", placeholder: "https://github.com" },
    guide: "github",
  },
  gitlab: {
    where: "GitLab → User settings → Applications. Tick Confidential and the api scope.",
    instance: { label: "GitLab address", placeholder: "https://gitlab.com" },
    guide: "gitlab",
  },
  forgejo: {
    where: "Settings → Applications → Manage OAuth2 applications. Tick Confidential client.",
    instance: { label: "Forgejo or Gitea address", placeholder: "https://codeberg.org" },
    guide: "codeberg-forgejo-and-gitea",
  },
  jira: {
    where: "developer.atlassian.com → Create → OAuth 2.0 integration, with the Jira API permissions.",
    guide: "jira-cloud",
  },
  linear: { where: "Linear → Settings → API → OAuth applications → New.", guide: "linear" },
  azuredevops: {
    where:
      "Microsoft Entra ID → App registrations → New registration, with the Azure DevOps user_impersonation permission.",
    guide: "azure-devops",
  },
};

const SOURCE: Record<TrackerApp["source"], string> = {
  None: "Not set up",
  Config: "Server configuration",
  Admin: "Added here",
};

/**
 * Instance admins set up the OAuth apps that people connect their own tracker accounts through (Home → Tracker
 * accounts), without editing the server's configuration or restarting it.
 */
export function TrackerAppsSection() {
  const apps = useQuery(queries.admin.trackerApps());
  const [editing, setEditing] = useState<TrackerApp | null>(null);
  const action = useAction();

  if (!apps.data) return apps.error ? <ErrorText error={apps.error} /> : <Loading />;

  const remove = (a: TrackerApp) =>
    action.run(() => api.delete("/api/admin/tracker-apps/{kind}", { params: { path: { kind: a.kind } } }));

  return (
    <section>
      <SectionTitle>Tracker apps</SectionTitle>
      <p className="mb-3 max-w-2xl text-sm text-muted-foreground">
        Set up a tracker here and people can connect their own account to it under Tracker accounts on the home page, so
        what they do from Inklayer shows as them. It works as soon as you save. Apps set in the server's configuration
        are changed there. <GuideLink section="registering-the-oauth-apps" />
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tracker</TableHead>
            <TableHead>Set up in</TableHead>
            <TableHead>Connected accounts</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.data.map((a) => (
            <TableRow key={a.kind}>
              <TableCell>
                {a.name}
                {a.needsSecret && (
                  <Badge variant="destructive" className="ml-2">
                    Enter its secret again
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">{SOURCE[a.source]}</TableCell>
              <TableCell className="text-muted-foreground">{a.accounts}</TableCell>
              <TableCell className="text-right">
                {a.source !== "Config" && (
                  <span className="inline-flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        action.reset();
                        setEditing(a);
                      }}
                    >
                      {a.source === "None" ? "Set up" : "Edit"}
                    </Button>
                    {a.source === "Admin" && (
                      <ConfirmButton
                        title={`Remove the ${a.name} app?`}
                        description={
                          a.accounts > 0
                            ? `${a.accounts} ${a.accounts === 1 ? "person's account is" : "people's accounts are"} disconnected, and nobody can connect ${a.name} until it's set up again.`
                            : `Nobody can connect ${a.name} until it's set up again.`
                        }
                        confirmLabel="Remove"
                        onConfirm={() => void remove(a)}
                      >
                        Remove
                      </ConfirmButton>
                    )}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editing && <TrackerAppForm key={editing.kind} app={editing} onDone={() => setEditing(null)} />}
      <div className="mt-2">
        <ErrorText error={action.error} />
      </div>
    </section>
  );
}

function TrackerAppForm({ app, onDone }: { app: TrackerApp; onDone: () => void }) {
  const info = TRACKERS[app.kind];
  const isNew = app.source === "None";
  const defaultInstance = info.instance?.placeholder;
  const [clientId, setClientId] = useState(app.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  // Only an address other than the tracker's usual one is kept, so an empty box means the usual one.
  const [url, setUrl] = useState(app.url && app.url !== defaultInstance ? app.url : "");
  const [tenantId, setTenantId] = useState(app.tenantId && app.tenantId !== "organizations" ? app.tenantId : "");
  const [copied, setCopied] = useState(false);
  const action = useAction();

  const sameApp =
    isNew ||
    (clientId.trim() === (app.clientId ?? "") &&
      (url.trim().replace(/\/+$/, "") || defaultInstance) === (app.url ?? defaultInstance) &&
      (tenantId.trim() || "organizations") === (app.tenantId ?? "organizations"));
  const needsSecret = isNew || app.needsSecret;

  const copy = async () => {
    await navigator.clipboard.writeText(app.callbackUrl);
    setCopied(true);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const saved = await action.run(() =>
      api.put("/api/admin/tracker-apps/{kind}", {
        params: { path: { kind: app.kind } },
        body: { clientId, clientSecret: clientSecret || null, url: url || null, tenantId: tenantId || null },
      }),
    );
    if (saved.ok) onDone();
  };

  return (
    <form className="mt-4 max-w-xl rounded-lg border p-4" onSubmit={save}>
      <FieldGroup className="gap-5">
        <p className="font-medium">{isNew ? `Set up ${app.name}` : `Change the ${app.name} app`}</p>
        <Field>
          <FieldLabel>1. Register an OAuth app</FieldLabel>
          <FieldDescription>
            {info.where} <GuideLink section={info.guide}>Step by step</GuideLink>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>2. Give it this callback (redirect) URL</FieldLabel>
          <div className="flex items-center gap-2">
            <code className="truncate rounded bg-muted px-2 py-1 text-sm">{app.callbackUrl}</code>
            <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
              <CopyIcon className="size-4" />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </Field>
        {info.instance && (
          <Field>
            <FieldLabel htmlFor="tracker-app-url">{info.instance.label}</FieldLabel>
            <Input
              id="tracker-app-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={info.instance.placeholder}
            />
            <FieldDescription>
              Leave empty for {info.instance.placeholder.replace("https://", "")}. People's own accounts are used for
              connections to this one instance.
            </FieldDescription>
          </Field>
        )}
        {app.kind === "azuredevops" && (
          <Field>
            <FieldLabel htmlFor="tracker-app-tenant">Directory (tenant) ID</FieldLabel>
            <Input
              id="tracker-app-tenant"
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="organizations"
            />
            <FieldDescription>Leave empty to allow any work or school account.</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="tracker-app-client-id">3. Client ID</FieldLabel>
          <Input id="tracker-app-client-id" value={clientId} onChange={(e) => setClientId(e.target.value)} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="tracker-app-secret">Client secret</FieldLabel>
          <Input
            id="tracker-app-secret"
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={needsSecret ? "" : "Leave empty to keep the current secret"}
            required={needsSecret}
          />
          <FieldDescription>
            {app.needsSecret
              ? "The saved secret can't be read on this server any more (the database was restored without the server's keys). Enter it again."
              : "Stored encrypted, and never shown again."}
          </FieldDescription>
        </Field>
        {!sameApp && app.accounts > 0 && (
          <p className="text-sm text-destructive">
            Changing the client ID or address disconnects the {app.accounts}{" "}
            {app.accounts === 1 ? "account" : "accounts"} connected through the current app; people connect again.
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={action.pending}>
            {action.pending ? "Saving…" : isNew ? `Set up ${app.name}` : "Save"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
        <ErrorText error={action.error} />
      </FieldGroup>
    </form>
  );
}
