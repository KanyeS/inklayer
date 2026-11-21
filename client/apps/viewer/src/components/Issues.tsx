import type {
  FoundIssue,
  IssueCommentResponse,
  IssueResponse,
  TrackerConnectionResponse,
  TrackerSettings,
} from "@inklayer/api";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Field, FieldDescription, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { cn } from "@inklayer/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleDot, ExternalLink, Link2, Plus } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { GuideLink } from "@/components/GuideLink";
import { IssueTypeChoice, IssueTypeField, ParentField, SavedIssueType, TYPED_KINDS } from "@/components/IssueTypes";
import { ErrorText } from "@/components/Layout";
import { accountName, connectTrackerUrl } from "@/components/TrackerAccounts";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { queries } from "@/lib/queries";
import { useAction } from "@/lib/query";

export type Issue = IssueResponse;
export type IssueComment = IssueCommentResponse;
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

type IssueMode = "new" | "existing";

/**
 * "Create issue" and "Link existing issue" for a comment, in one of the project's connected trackers. Hidden when none
 * are connected. Linking searches the tracker's open issues, or takes a pasted address or number.
 */
export function CreateIssueButton({ commentId, projectId }: { commentId: string; projectId: string }) {
  const choices = useQuery(queries.issueTrackerChoices(projectId));
  const [mode, setMode] = useState<IssueMode | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState("");
  const [issueType, setIssueType] = useState("");
  const { run, error, pending: busy } = useAction();

  const first = choices.data?.[0];
  if (!choices.data || !first) return null;
  const chosen = connectionId || first.id;
  const choice = choices.data.find((c) => c.id === chosen) ?? first;
  const trackerName = choices.data.length === 1 ? first.name : "tracker";

  if (!mode) {
    return (
      <>
        <Button variant="outline" onClick={() => setMode("new")}>
          <Plus data-icon="inline-start" />
          Create issue
        </Button>
        <Button variant="outline" onClick={() => setMode("existing")}>
          <Link2 data-icon="inline-start" />
          Link existing issue
        </Button>
      </>
    );
  }

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const created = await run(() =>
      api.post("/api/annotations/{annotationId}/issues", {
        params: { path: { annotationId: commentId } },
        body: {
          connectionId: chosen,
          title: title.trim() || undefined,
          parent: TYPED_KINDS.has(choice.kind) ? parent.trim() || undefined : undefined,
          type: TYPED_KINDS.has(choice.kind) ? issueType || undefined : undefined,
        },
      }),
    );
    if (created.ok) {
      setMode(null);
      setTitle("");
      setParent("");
    }
  };

  return (
    <div className="mt-3 flex w-full flex-col gap-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist" aria-label="Issue">
          {(["new", "existing"] as const).map((m) => (
            <Button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              size="sm"
              variant={mode === m ? "secondary" : "ghost"}
              onClick={() => setMode(m)}
            >
              {m === "new" ? "New issue" : "Existing issue"}
            </Button>
          ))}
        </div>
        {choices.data.length > 1 && (
          <NativeSelect aria-label="Tracker" value={chosen} onChange={(e) => setConnectionId(e.target.value)}>
            {choices.data.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {TRACKER_NAMES[c.kind]}: {c.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </div>
      {choice.postsAs === "connect" ? (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p className="text-muted-foreground">
            Issues here are created and linked as your own {TRACKER_NAMES[choice.kind]} account. Connect it first; you
            come straight back here.
          </p>
          <div className="flex items-center gap-2">
            <Button nativeButton={false} render={<a href={connectTrackerUrl(choice.kind)} />}>
              <ExternalLink data-icon="inline-start" />
              Connect {TRACKER_NAMES[choice.kind]}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "existing" ? (
        <LinkIssueForm
          key={chosen}
          commentId={commentId}
          projectId={projectId}
          connectionId={chosen}
          trackerName={trackerName}
          onDone={() => setMode(null)}
        />
      ) : (
        <form onSubmit={create} className="flex flex-col gap-2">
          <Input
            aria-label="Issue title"
            placeholder="Title (defaults to the comment's first line)"
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
          {TYPED_KINDS.has(choice.kind) && (
            <IssueTypeChoice
              key={`type-${chosen}`}
              projectId={projectId}
              connectionId={chosen}
              value={issueType}
              onChange={setIssueType}
            />
          )}
          {TYPED_KINDS.has(choice.kind) && (
            <ParentField
              key={chosen}
              projectId={projectId}
              connectionId={chosen}
              label={choice.kind === "jira" ? "Sub-task of (optional)" : "Child of (optional)"}
              value={parent}
              onChange={setParent}
            />
          )}
          <p className="text-xs text-muted-foreground">
            The issue gets the comment, its replies, the page and its details. Closing the issue resolves the comment.{" "}
            <PostsAs choice={choice} />
          </p>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={busy}>
              Create in {trackerName}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <ErrorText error={error} />
          </div>
        </form>
      )}
    </div>
  );
}

/** Who an issue or note will come from in the tracker. */
function PostsAs({ choice }: { choice: { postsAs: string; login?: string | null; kind: TrackerKind } }) {
  if (choice.postsAs === "you" && choice.login) return <>Posted as {accountName(choice.kind, choice.login)}.</>;
  if (choice.postsAs === "shared") return <>Posted as the project's shared {TRACKER_NAMES[choice.kind]} account.</>;
  return null;
}

/** Finds an issue that already exists (by title, or a pasted address or number) and links it to the comment. */
function LinkIssueForm({
  commentId,
  projectId,
  connectionId,
  trackerName,
  onDone,
}: {
  commentId: string;
  projectId: string;
  connectionId: string;
  trackerName: string;
  onDone: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundIssue[] | null>(null);
  const [searchError, setSearchError] = useState<Error | null>(null);
  const [picked, setPicked] = useState<FoundIssue | null>(null);
  const [addComment, setAddComment] = useState(true);
  const { run, error, pending: busy } = useAction();

  // Searches as you type, after a pause; an empty box lists the open issues.
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      api
        .get("/api/projects/{projectId}/issue-trackers/{id}/search", {
          params: { path: { projectId, id: connectionId }, query: { q: query.trim() } },
        })
        .then((found) => {
          if (!current) return;
          setResults(found);
          setSearchError(null);
        })
        .catch((e: unknown) => {
          if (!current) return;
          setResults([]);
          setSearchError(e instanceof Error ? e : new Error("Search failed."));
        });
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query, projectId, connectionId]);

  const link = async (e: FormEvent) => {
    e.preventDefault();
    const reference = picked?.url ?? query.trim();
    if (!reference) return;
    const linked = await run(() =>
      api.post("/api/annotations/{annotationId}/issues/link", {
        params: { path: { annotationId: commentId } },
        body: { connectionId, reference, addComment },
      }),
    );
    if (linked.ok) onDone();
  };

  return (
    <form onSubmit={link} className="flex flex-col gap-2">
      <Input
        aria-label="Find an issue"
        placeholder="Search titles, or paste the issue's address or number"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setPicked(null);
        }}
      />
      <ul className="max-h-60 divide-y overflow-y-auto rounded-lg border empty:hidden" aria-label="Issues found">
        {results?.map((r) => (
          <li key={r.externalId}>
            <button
              type="button"
              aria-pressed={picked?.externalId === r.externalId}
              onClick={() => setPicked(r)}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted",
                picked?.externalId === r.externalId && "bg-muted",
              )}
            >
              {r.state === "open" ? (
                <CircleDot className="size-3.5 shrink-0 text-green-600" />
              ) : (
                <CircleCheck className="size-3.5 shrink-0 text-purple-600" />
              )}
              <span className="shrink-0 font-medium">{r.key}</span>
              <span className="min-w-0 truncate">{r.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {results?.length === 0 && !searchError && <p className="text-xs text-muted-foreground">No open issues match.</p>}
      <ErrorText error={searchError} />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={addComment} onCheckedChange={(on) => setAddComment(on === true)} />
        Add this comment to the issue
      </label>
      <p className="text-xs text-muted-foreground">
        The issue's comments show in this thread, and closing it resolves the comment.
      </p>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy || (!picked && !query.trim())}>
          {picked ? `Link ${picked.key}` : `Link from ${trackerName}`}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}

/** A comment on a linked issue, written in the tracker: read-only, in the thread with the replies. */
export function IssueCommentItem({ comment }: { comment: IssueComment }) {
  const name = comment.authorUrl ? (
    <a
      href={comment.authorUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-foreground hover:underline"
    >
      {comment.authorName}
    </a>
  ) : (
    <span className="font-medium text-foreground">{comment.authorName}</span>
  );
  return (
    <li className="rounded-2xl border border-dashed bg-muted/30 px-4 py-3">
      <p className="mb-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {name}
        <span title={dateTime(comment.createdAt)}>{timeAgo(comment.createdAt)}</span>
        <a
          href={comment.issueUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex items-center gap-1 hover:underline"
        >
          on {TRACKER_NAMES[comment.kind]} {comment.issueKey}
          <ExternalLink className="size-3" />
        </a>
      </p>
      <p className="whitespace-pre-wrap">{comment.body}</p>
    </li>
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

/** Where trackers are when no address is given. */
const DEFAULT_SITE: Partial<Record<TrackerKind, string>> = {
  gitlab: "https://gitlab.com",
  forgejo: "https://codeberg.org",
};

const sameSite = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

/**
 * Whether people's own accounts work for a connection with these settings (the server decides; this mirrors it for the
 * form): GitHub.com, the GitLab or Forgejo instance the server's app is on, Azure DevOps Services, and any Jira or Linear.
 */
function usesOwnAccounts(kind: TrackerKind, settings: TrackerSettings, instance: string | null): boolean {
  switch (kind) {
    case "github":
      return !settings.apiUrl;
    case "gitlab":
    case "forgejo":
      return !!instance && sameSite(settings.site || DEFAULT_SITE[kind] || "", instance);
    case "azuredevops":
      return /^https:\/\/(dev\.azure\.com|[^/]+\.visualstudio\.com)(\/|$)/i.test(settings.site ?? "");
    default:
      return true;
  }
}

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
                {t.personalAccounts
                  ? t.tokenHint
                    ? `People act as their own accounts; shared token ${t.tokenHint} for the rest`
                    : "People act as their own accounts"
                  : `Token ${t.tokenHint ?? ""}`}{" "}
                ·{" "}
                {t.closeIssueOnResolve
                  ? "Closes issues when comments are resolved"
                  : "Leaves issues open when comments are resolved"}{" "}
                · {t.postRepliesToIssue ? "Posts Inklayer replies to issues" : "Keeps Inklayer replies in Inklayer"}
              </p>
              {TYPED_KINDS.has(t.kind) && <SavedIssueType projectId={projectId} tracker={t} />}
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
              {t.personalAccounts && t.tokenHint && (
                <ConfirmButton
                  title="Remove the shared token?"
                  description="Everyone then acts as their own account; people who haven't connected one are asked to."
                  confirmLabel="Remove"
                  onConfirm={() =>
                    void run(() =>
                      api.patch("/api/projects/{projectId}/issue-trackers/{id}", {
                        params: { path: { projectId, id: t.id } },
                        body: { removeToken: true },
                      }),
                    )
                  }
                >
                  Remove shared token
                </ConfirmButton>
              )}
              <Button
                variant="ghost"
                size="sm"
                title="Replies are posted as their author's own account; else as the shared account, with their name."
                onClick={() =>
                  void run(() =>
                    api.patch("/api/projects/{projectId}/issue-trackers/{id}", {
                      params: { path: { projectId, id: t.id } },
                      body: { postRepliesToIssue: !t.postRepliesToIssue },
                    }),
                  )
                }
              >
                {t.postRepliesToIssue ? "Don't post replies" : "Post replies"}
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
  const accounts = useQuery(queries.trackerAccounts());
  const [kind, setKind] = useState<TrackerKind>("github");
  const [settings, setSettings] = useState<TrackerSettings>({});
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [closeIssueOnResolve, setClose] = useState(true);
  const [postRepliesToIssue, setPostReplies] = useState(false);
  const { run, error, pending: busy } = useAction();
  // People can act as their own accounts (GitHub.com, when the server has the OAuth app): the token is optional then.
  const account = accounts.data?.find((a) => a.kind === kind);
  const personal = !!account && usesOwnAccounts(kind, settings, account.site ?? null);
  const set = (key: keyof TrackerSettings) => (e: { target: { value: string } }) =>
    setSettings((s) => ({ ...s, [key]: e.target.value }));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const added = await run(() =>
      api.post("/api/projects/{projectId}/issue-trackers", {
        params: { path: { projectId } },
        body: {
          kind,
          name: name || undefined,
          token: token || undefined,
          settings,
          closeIssueOnResolve,
          postRepliesToIssue,
        },
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
          {text(
            "email",
            personal ? "Account email (for a shared token)" : "Account email",
            "bot@acme.com",
            !personal || !!token,
          )}
          <IssueTypeField
            projectId={projectId}
            kind={kind}
            label="Issue type"
            settings={settings}
            token={token}
            value={settings.issueType ?? ""}
            onChange={(issueType) => setSettings((s) => ({ ...s, issueType }))}
          />
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
          <IssueTypeField
            projectId={projectId}
            kind={kind}
            label="Work item type"
            settings={settings}
            token={token}
            value={settings.issueType ?? ""}
            onChange={(issueType) => setSettings((s) => ({ ...s, issueType }))}
          />
        </div>
      )}
      {personal && (
        <p className="text-sm text-muted-foreground">
          People create issues, post replies and close issues as their own {TRACKER_NAMES[kind]} accounts.{" "}
          {account.login
            ? `Your account (${account.login}) checks the settings.`
            : `Connect your own account first, on the home page, so Inklayer can check the settings.`}
        </p>
      )}
      <Field>
        <FieldLabel htmlFor="tracker-token">
          {personal ? `Shared ${TOKEN_LABEL[kind].toLowerCase()} (optional)` : TOKEN_LABEL[kind]}
        </FieldLabel>
        <Input
          id="tracker-token"
          type="password"
          required={!personal}
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <FieldDescription>
          {personal &&
            "For people who haven't connected their own account: a bot account's token, say. Leave it empty and they're asked to connect. "}
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
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={postRepliesToIssue} onCheckedChange={(on) => setPostReplies(on === true)} />
        {personal
          ? "Post replies written in Inklayer to the issue (as each person's own account)"
          : "Post replies written in Inklayer to the issue (as the token's account)"}
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
