import type { IssueResponse, TrackerConnectionResponse, TrackerSettings } from "@inklayer/api";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDot, ExternalLink, Plus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { GuideLink } from "@/components/GuideLink";
import { ErrorText } from "@/components/Layout";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";

export type Issue = IssueResponse;
export type TrackerKind = TrackerConnectionResponse["kind"];
type Tracker = TrackerConnectionResponse;

export const TRACKER_NAMES: Record<TrackerKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  jira: "Jira",
  linear: "Linear",
  azuredevops: "Azure DevOps",
};

/** Issues linked to a comment: tracker, key and whether it's still open. */
export function IssueChips({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {issues.map((i) => (
        <a
          key={i.id}
          href={i.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm hover:bg-muted"
          title={`${TRACKER_NAMES[i.kind]} ${i.key} (${i.state})`}
        >
          {i.state === "open" ? (
            <CircleDot className="size-3.5 text-green-600" />
          ) : (
            <CircleCheck className="size-3.5 text-purple-600" />
          )}
          {TRACKER_NAMES[i.kind]} {i.key}
          <ExternalLink className="size-3 text-muted-foreground" />
        </a>
      ))}
    </div>
  );
}

/** "Create issue" for a comment, in one of the project's connected trackers. Hidden when none are connected. */
export function CreateIssueButton({ commentId, projectId }: { commentId: string; projectId: string }) {
  const choices = useQuery(queries.issueTrackerChoices(projectId));
  const [open, setOpen] = useState(false);
  const [connectionId, setConnectionId] = useState("");
  const [title, setTitle] = useState("");
  const { run, error, pending: busy } = useAction();

  const first = choices.data?.[0];
  if (!choices.data || !first) return null;
  const chosen = connectionId || first.id;

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" />
        Create issue
      </Button>
    );
  }

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const created = await run(() =>
      api.post("/api/annotations/{annotationId}/issues", {
        params: { path: { annotationId: commentId } },
        body: { connectionId: chosen, title: title.trim() || undefined },
      }),
    );
    if (created.ok) {
      setOpen(false);
      setTitle("");
    }
  };

  return (
    <form onSubmit={create} className="mt-3 flex w-full flex-col gap-2 rounded-xl border p-3">
      <div className="flex flex-wrap gap-2">
        {choices.data.length > 1 && (
          <NativeSelect aria-label="Tracker" value={chosen} onChange={(e) => setConnectionId(e.target.value)}>
            {choices.data.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {TRACKER_NAMES[c.kind]}: {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <Input
          className="min-w-48 flex-1"
          aria-label="Issue title"
          placeholder="Title (defaults to the comment's first line)"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        The issue gets the comment, its replies, the page and its details. Closing the issue resolves the comment.
      </p>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          Create in {choices.data.length === 1 ? first.name : "tracker"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}

const HELP: Record<TrackerKind, string> = {
  github: "A fine-grained personal access token with Issues: read and write on the repository.",
  gitlab:
    "A personal, project or group access token with the api scope, from someone with at least the Reporter role in the project.",
  forgejo:
    "An access token (Settings → Applications) with issue: Read and write, and repository: Read. Codeberg by default; for your own Forgejo or Gitea, give its address.",
  jira: "An Atlassian API token (id.atlassian.com → Security → API tokens) for the account email below.",
  linear:
    "A personal API key (Linear → Settings → Security & access). The team id is in the team's settings, or copy it with Cmd/Ctrl+K → “Copy model UUID”.",
  azuredevops:
    "A personal access token (User settings → Personal access tokens) with the Work Items: Read & write scope, for this organisation.",
};

const TOKEN_LABEL: Record<TrackerKind, string> = {
  github: "Token",
  gitlab: "Access token",
  forgejo: "Access token",
  jira: "API token",
  linear: "API key",
  azuredevops: "Personal access token",
};

/** Each tracker's section in the integrations setup guide. */
const GUIDE_SECTION = {
  github: "github",
  gitlab: "gitlab",
  forgejo: "codeberg-forgejo-and-gitea",
  jira: "jira-cloud",
  linear: "linear",
  azuredevops: "azure-devops",
} as const satisfies Record<TrackerKind, string>;

/** Picker labels where the tracker covers more than its name says. */
const PICKER_LABEL: Partial<Record<TrackerKind, string>> = { forgejo: "Codeberg, Forgejo, Gitea" };

/** A project's connected issue trackers, for project Admins: any number of each kind (repositories, projects, teams). */
export function IssueTrackersSection({ projectId }: { projectId: string }) {
  const trackers = useQuery(queries.issueTrackers(projectId));
  const { run, error } = useAction();
  const [tested, setTested] = useState<Record<string, string>>({});

  const test = async (t: Tracker) => {
    const result = await api.post("/api/projects/{projectId}/issue-trackers/{id}/test", {
      params: { path: { projectId, id: t.id } },
    });
    setTested((s) => ({ ...s, [t.id]: result.ok ? "Connected ✓" : `Failed: ${result.error}` }));
  };

  return (
    <section className="mt-10 max-w-3xl space-y-4">
      <div>
        <h2 className="font-heading text-base font-semibold">Issue trackers</h2>
        <p className="text-sm text-muted-foreground">
          Commenters can turn comments into issues. Inklayer checks linked issues every few minutes: closing one
          resolves its comment, reopening it reopens the comment. <GuideLink section="issue-trackers" />
        </p>
      </div>
      <ErrorText error={error ?? trackers.error} />
      <ul className="divide-y rounded-xl border empty:hidden">
        {trackers.data?.map((t) => (
          <li key={t.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 font-medium">
                {t.name} <Badge variant="outline">{TRACKER_NAMES[t.kind]}</Badge>
              </p>
              <p className="text-sm text-muted-foreground">
                Token {t.tokenHint} ·{" "}
                {t.closeIssueOnResolve
                  ? "Closes issues when comments are resolved"
                  : "Leaves issues open when comments are resolved"}
              </p>
              {t.lastError && t.lastErrorAt && (
                <p className="text-sm text-destructive">
                  {timeAgo(t.lastErrorAt)}: {t.lastError}
                </p>
              )}
              {tested[t.id] && <p className="text-xs">{tested[t.id]}</p>}
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => void test(t)}>
                Test
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void run(() =>
                    api.patch("/api/projects/{projectId}/issue-trackers/{id}", {
                      params: { path: { projectId, id: t.id } },
                      body: { closeIssueOnResolve: !t.closeIssueOnResolve },
                    }),
                  )
                }
              >
                {t.closeIssueOnResolve ? "Don't close issues" : "Close issues"}
              </Button>
              <ConfirmButton
                title={`Disconnect ${t.name}?`}
                description="Issues already created stay in the tracker; their links are removed from comments."
                confirmLabel="Disconnect"
                onConfirm={() =>
                  void run(() =>
                    api.delete("/api/projects/{projectId}/issue-trackers/{id}", {
                      params: { path: { projectId, id: t.id } },
                    }),
                  )
                }
              >
                Disconnect
              </ConfirmButton>
            </div>
          </li>
        ))}
      </ul>
      <AddTracker projectId={projectId} />
    </section>
  );
}

function AddTracker({ projectId }: { projectId: string }) {
  const [kind, setKind] = useState<TrackerKind>("github");
  const [settings, setSettings] = useState<TrackerSettings>({});
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [closeIssueOnResolve, setClose] = useState(true);
  const { run, error, pending: busy } = useAction();
  const set = (key: keyof TrackerSettings) => (e: { target: { value: string } }) =>
    setSettings((s) => ({ ...s, [key]: e.target.value }));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const added = await run(() =>
      api.post("/api/projects/{projectId}/issue-trackers", {
        params: { path: { projectId } },
        body: { kind, name: name || undefined, token, settings, closeIssueOnResolve },
      }),
    );
    if (added.ok) {
      setSettings({});
      setToken("");
      setName("");
    }
  };

  const text = (id: keyof TrackerSettings, label: string, placeholder: string, required = true) => (
    <Field key={id}>
      <FieldLabel htmlFor={`tracker-${id}`}>{label}</FieldLabel>
      <Input
        id={`tracker-${id}`}
        required={required}
        placeholder={placeholder}
        value={settings[id] ?? ""}
        onChange={set(id)}
      />
    </Field>
  );

  return (
    <form onSubmit={add} className="space-y-4 rounded-xl border p-4">
      <h3 className="font-heading font-semibold">Connect a tracker</h3>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(TRACKER_NAMES) as TrackerKind[]).map((k) => (
          <Button
            key={k}
            type="button"
            variant={kind === k ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setKind(k);
              setSettings({});
            }}
          >
            {PICKER_LABEL[k] ?? TRACKER_NAMES[k]}
          </Button>
        ))}
      </div>
      {kind === "github" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("owner", "Owner", "acme")}
          {text("repo", "Repository", "website")}
        </div>
      )}
      {kind === "jira" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("site", "Site", "https://acme.atlassian.net")}
          {text("projectKey", "Project key", "WEB")}
          {text("email", "Account email", "bot@acme.com")}
          {text("issueType", "Issue type", "Bug", false)}
        </div>
      )}
      {kind === "linear" && text("teamId", "Team id", "a1b2c3d4-…")}
      {kind === "gitlab" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("projectKey", "Project path", "acme/website")}
          {text("site", "Instance address (self-managed only)", "https://gitlab.com", false)}
        </div>
      )}
      {kind === "forgejo" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("owner", "Owner", "acme")}
          {text("repo", "Repository", "website")}
          {text("site", "Instance address", "https://codeberg.org", false)}
        </div>
      )}
      {kind === "azuredevops" && (
        <div className="grid gap-4 sm:grid-cols-2">
          {text("site", "Organisation address", "https://dev.azure.com/acme")}
          {text("projectKey", "Project", "Web Shop")}
          {text("issueType", "Work item type", "Bug", false)}
        </div>
      )}
      <Field>
        <FieldLabel htmlFor="tracker-token">{TOKEN_LABEL[kind]}</FieldLabel>
        <Input
          id="tracker-token"
          type="password"
          required
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <FieldDescription>
          {HELP[kind]} Stored encrypted; only its last four characters are shown again.{" "}
          <GuideLink section={GUIDE_SECTION[kind]}>Step-by-step setup</GuideLink>
        </FieldDescription>
      </Field>
      {kind === "github" &&
        text("apiUrl", "API address (GitHub Enterprise only)", "https://github.acme.com/api/v3", false)}
      <Field>
        <FieldLabel htmlFor="tracker-name">Name</FieldLabel>
        <Input
          id="tracker-name"
          placeholder="Shown to commenters"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={closeIssueOnResolve} onCheckedChange={(on) => setClose(on === true)} />
        Close the issue when its comment is resolved
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Checking…" : `Connect ${TRACKER_NAMES[kind]}`}
        </Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}
