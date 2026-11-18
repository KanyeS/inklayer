import { useState, type FormEvent } from "react";
import { Hash, Mail, Webhook } from "lucide-react";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText } from "@/components/Layout";
import { del, get, patch, post, type Project } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";

type Kind = "email" | "slack" | "webhook";

interface Integration {
  id: string;
  kind: Kind;
  name: string;
  enabled: boolean;
  events: string[];
  projectId: string | null;
  target: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

const EVENTS: { id: string; label: string }[] = [
  { id: "comment.created", label: "New comments" },
  { id: "mention", label: "Mentions" },
  { id: "reply", label: "Replies" },
  { id: "comment.resolved", label: "Resolved comments" },
  { id: "issue.created", label: "Issues created" },
];

const KINDS: Record<Kind, { label: string; icon: typeof Mail; help: string }> = {
  email: { label: "Email", icon: Mail, help: "Emails people their own notifications (mentions, replies in their threads, their comments resolved). Each person can turn it off in Settings." },
  slack: { label: "Slack", icon: Hash, help: "Posts to a channel. Create an incoming webhook in Slack (Apps → Incoming Webhooks) and paste its address." },
  webhook: { label: "Webhook", icon: Webhook, help: "Posts JSON to any https address, signed with X-Inklayer-Signature (HMAC-SHA256 of the body). Works for Teams, Discord or your own tools." },
};

/**
 * Where an organisation's notifications go besides everyone's in-app inbox: as many email, Slack and webhook
 * integrations as you like. Organisation Admins only.
 */
export function IntegrationsSection({ orgId }: { orgId: string }) {
  const integrations = useAsync(() => get<Integration[]>(`/api/orgs/${orgId}/integrations`), [orgId]);
  const projects = useAsync(() => get<Project[]>(`/api/orgs/${orgId}/projects`), [orgId]);
  const [error, setError] = useState<Error | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
    await integrations.reload();
  };

  const test = async (i: Integration) => {
    const result = await post<{ ok: boolean; error: string | null }>(`/api/orgs/${orgId}/integrations/${i.id}/test`);
    setTested((t) => ({ ...t, [i.id]: result.ok ? "Sent ✓" : `Failed: ${result.error}` }));
    await integrations.reload();
  };

  return (
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Everyone gets notifications under the bell. Add integrations to also send them by email, to Slack channels, or to other tools. Add as many as you like.
      </p>
      <ErrorText error={error ?? integrations.error} />
      {secret && (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm">
          <p className="font-medium">Signing secret (shown once):</p>
          <code className="mt-1 block break-all">{secret}</code>
          <p className="mt-1 text-muted-foreground">Receivers check X-Inklayer-Signature: sha256=HMAC-SHA256(secret, body).</p>
          <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setSecret(null)}>I've saved it</Button>
        </div>
      )}

      <ul className="divide-y rounded-xl border empty:hidden">
        {integrations.data?.map((i) => {
          const Icon = KINDS[i.kind].icon;
          const project = projects.data?.find((p) => p.id === i.projectId);
          return (
            <li key={i.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {i.name} <Badge variant="outline">{KINDS[i.kind].label}</Badge>{!i.enabled && <Badge variant="secondary">Paused</Badge>}
                </p>
                <p className="text-sm text-muted-foreground">
                  {i.kind === "email" ? "People's own notifications" : `${i.events.map((e) => EVENTS.find((x) => x.id === e)?.label ?? e).join(", ")}${project ? ` · ${project.name} only` : ""}`}
                  {i.target && ` · ${i.target}`}
                </p>
                {i.lastError && i.lastErrorAt && (!i.lastSuccessAt || i.lastErrorAt > i.lastSuccessAt) && (
                  <p className="text-sm text-destructive">Last attempt failed {timeAgo(i.lastErrorAt)}: {i.lastError}</p>
                )}
                {i.lastSuccessAt && <p className="text-xs text-muted-foreground">Last sent {timeAgo(i.lastSuccessAt)}</p>}
                {tested[i.id] && <p className="text-xs">{tested[i.id]}</p>}
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => void test(i)}>Test</Button>
                <Button variant="ghost" size="sm" onClick={() => void run(() => patch(`/api/orgs/${orgId}/integrations/${i.id}`, { enabled: !i.enabled }))}>{i.enabled ? "Pause" : "Resume"}</Button>
                <ConfirmButton title={`Remove ${i.name}?`} confirmLabel="Remove" onConfirm={() => void run(() => del(`/api/orgs/${orgId}/integrations/${i.id}`))}>Remove</ConfirmButton>
              </div>
            </li>
          );
        })}
      </ul>

      <AddIntegration orgId={orgId} projects={projects.data ?? []} onAdded={async (s) => { setSecret(s); await integrations.reload(); }} />
    </div>
  );
}

function AddIntegration({ orgId, projects, onAdded }: { orgId: string; projects: Project[]; onAdded: (secret: string | null) => Promise<void> }) {
  const [kind, setKind] = useState<Kind>("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(EVENTS.map((e) => e.id));
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<Error | null>(null);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const created = await post<{ secret: string | null }>(`/api/orgs/${orgId}/integrations`, {
        kind, name: name || undefined, url: kind === "email" ? undefined : url, events, projectId: projectId || undefined,
      });
      setName("");
      setUrl("");
      setError(null);
      await onAdded(created.secret);
    } catch (err) {
      setError(err as Error);
    }
  };

  return (
    <form onSubmit={add} className="space-y-4 rounded-xl border p-4">
      <h3 className="font-heading font-semibold">Add an integration</h3>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(KINDS) as Kind[]).map((k) => {
          const Icon = KINDS[k].icon;
          return (
            <Button key={k} type="button" variant={kind === k ? "default" : "outline"} size="sm" onClick={() => setKind(k)}>
              <Icon data-icon="inline-start" />{KINDS[k].label}
            </Button>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground">{KINDS[kind].help}</p>
      <Field>
        <FieldLabel htmlFor="integration-name">Name</FieldLabel>
        <Input id="integration-name" placeholder={kind === "slack" ? "#design-review" : KINDS[kind].label} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </Field>
      {kind !== "email" && (
        <>
          <Field>
            <FieldLabel htmlFor="integration-url">{kind === "slack" ? "Slack webhook address" : "Address"}</FieldLabel>
            <Input id="integration-url" type="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
            <FieldDescription>Stored encrypted; only its start and end are shown again.</FieldDescription>
          </Field>
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Send</legend>
            {EVENTS.map((ev) => (
              <label key={ev.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={events.includes(ev.id)} onCheckedChange={(on) => setEvents(on === true ? [...events, ev.id] : events.filter((x) => x !== ev.id))} />
                {ev.label}
              </label>
            ))}
          </fieldset>
          <Field>
            <FieldLabel htmlFor="integration-project">Projects</FieldLabel>
            <NativeSelect id="integration-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <NativeSelectOption value="">All projects</NativeSelectOption>
              {projects.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.name} only</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        </>
      )}
      <div className="flex items-center gap-3">
        <Button type="submit">Add {KINDS[kind].label.toLowerCase()}</Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}
