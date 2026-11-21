import type { FoundIssue, TrackerConnectionResponse, TrackerSettings } from "@inklayer/api";
import { Field, FieldDescription, FieldLabel } from "@inklayer/ui/components/field";
import { Input } from "@inklayer/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@inklayer/ui/components/native-select";
import { useEffect, useRef, useState } from "react";
import { ErrorText } from "@/components/Layout";
import { api } from "@/lib/api";
import { useAction } from "@/lib/query";

type Tracker = TrackerConnectionResponse;
type TrackerKind = Tracker["kind"];

/** Trackers whose projects have their own issue types: the form offers the project's, instead of a name to type in. */
export const TYPED_KINDS: ReadonlySet<TrackerKind> = new Set<TrackerKind>(["jira", "azuredevops"]);

/**
 * The project's issue types, from the tracker (`/issue-types`), once the settings say which project: `null` until then,
 * and the reason when the tracker couldn't be asked. `token` is a shared token being entered; `connectionId` a saved
 * tracker, whose own token is used.
 */
function useIssueTypes(
  projectId: string,
  kind: TrackerKind,
  settings: TrackerSettings,
  { token, connectionId, current }: { token?: string; connectionId?: string; current?: string },
) {
  const [state, setState] = useState<{ types: string[] | null; suggested: string | null; error: string | null }>({
    types: null,
    suggested: null,
    error: null,
  });
  const { site, projectKey, email } = settings;
  // Jira's shared token goes with an account email; without a token, the person's own account is used.
  const ready =
    TYPED_KINDS.has(kind) && !!site?.trim() && !!projectKey?.trim() && (kind !== "jira" || !token || !!email?.trim());
  const currentType = useRef(current);
  currentType.current = current;

  useEffect(() => {
    if (!ready) {
      setState({ types: null, suggested: null, error: null });
      return;
    }
    let live = true;
    // After a pause in typing, so the tracker isn't asked about every half-typed project name.
    const timer = window.setTimeout(() => {
      api
        .post("/api/projects/{projectId}/issue-trackers/issue-types", {
          params: { path: { projectId } },
          body: {
            kind,
            settings: { site, projectKey, email, issueType: currentType.current || undefined },
            token: token || undefined,
            connectionId,
          },
        })
        .then((found) => {
          if (live) setState({ types: found.types, suggested: found.suggested ?? null, error: null });
        })
        .catch((e: unknown) => {
          if (live)
            setState({
              types: null,
              suggested: null,
              error: e instanceof Error ? e.message : "Couldn't ask the tracker.",
            });
        });
    }, 500);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [ready, projectId, kind, site, projectKey, email, token, connectionId]);

  return { ...state, ready };
}

/**
 * "Issue type" / "Work item type" while connecting a tracker: a dropdown of the project's types once the project is
 * filled in, starting on the suggested one (Bug, Issue or Task). A text box until then, or when the tracker can't be asked.
 */
export function IssueTypeField({
  projectId,
  kind,
  label,
  settings,
  token,
  value,
  onChange,
}: {
  projectId: string;
  kind: TrackerKind;
  label: string;
  settings: TrackerSettings;
  token: string;
  value: string;
  onChange: (type: string) => void;
}) {
  const { types, suggested, error, ready } = useIssueTypes(projectId, kind, settings, { token, current: value });
  const pick = useRef(onChange);
  pick.current = onChange;
  // Start on the suggestion when what's chosen isn't one of the project's types.
  useEffect(() => {
    if (types && suggested && !types.includes(value)) pick.current(suggested);
  }, [types, suggested, value]);

  return (
    <Field>
      <FieldLabel htmlFor="tracker-issueType">{label}</FieldLabel>
      {types && types.length > 0 ? (
        <NativeSelect id="tracker-issueType" value={value} onChange={(e) => onChange(e.target.value)}>
          {types.map((type) => (
            <NativeSelectOption key={type} value={type}>
              {type}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      ) : (
        <Input id="tracker-issueType" placeholder="Bug" value={value} onChange={(e) => onChange(e.target.value)} />
      )}
      <FieldDescription>
        {error
          ? `Couldn't list the project's types: ${error}`
          : !ready
            ? "Fill in the project to choose from its types."
            : !types
              ? "Asking the project for its types…"
              : null}
      </FieldDescription>
    </Field>
  );
}

/** A saved Jira or Azure DevOps tracker's type, changed from the project's types. */
export function SavedIssueType({ projectId, tracker }: { projectId: string; tracker: Tracker }) {
  const current = tracker.settings.issueType?.trim() || "Bug";
  const { types, error } = useIssueTypes(projectId, tracker.kind, tracker.settings, {
    connectionId: tracker.id,
    current,
  });
  const { run, error: saveError, pending } = useAction();
  const label = tracker.kind === "azuredevops" ? "Work item type" : "Issue type";
  if (!types) {
    return (
      <p className="text-sm text-muted-foreground">
        {label}: {current}
        {error && ` (couldn't list the project's types: ${error})`}
      </p>
    );
  }
  const missing = !types.some((type) => type.toLowerCase() === current.toLowerCase());
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
      <label htmlFor={`issue-type-${tracker.id}`} className="text-muted-foreground">
        {label}
      </label>
      <NativeSelect
        id={`issue-type-${tracker.id}`}
        size="sm"
        disabled={pending}
        value={missing ? "" : (types.find((type) => type.toLowerCase() === current.toLowerCase()) ?? current)}
        onChange={(e) =>
          void run(() =>
            api.patch("/api/projects/{projectId}/issue-trackers/{id}", {
              params: { path: { projectId, id: tracker.id } },
              body: { settings: { ...tracker.settings, issueType: e.target.value } },
            }),
          )
        }
      >
        {missing && <NativeSelectOption value="">{current} (not in this project: choose another)</NativeSelectOption>}
        {types.map((type) => (
          <NativeSelectOption key={type} value={type}>
            {type}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <ErrorText error={saveError} />
    </div>
  );
}

/**
 * The issue to create the new one under (Jira: a sub-task, or an issue in an epic; Azure DevOps: a child work item):
 * its key, number or address, with the tracker's open issues matching what's typed offered as suggestions.
 */
export function ParentField({
  projectId,
  connectionId,
  label,
  value,
  onChange,
}: {
  projectId: string;
  connectionId: string;
  label: string;
  value: string;
  onChange: (parent: string) => void;
}) {
  const [found, setFound] = useState<FoundIssue[]>([]);
  useEffect(() => {
    const q = value.trim();
    if (!q) {
      setFound([]);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .get("/api/projects/{projectId}/issue-trackers/{id}/search", {
          params: { path: { projectId, id: connectionId }, query: { q } },
        })
        .then((issues) => {
          if (live) setFound(issues);
        })
        .catch(() => {
          if (live) setFound([]);
        });
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [projectId, connectionId, value]);

  const listId = `parents-${connectionId}`;
  return (
    <>
      <Input
        aria-label={label}
        placeholder={`${label}: search titles, or a key, #number or address`}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {found.map((issue) => (
          <option key={issue.externalId} value={issue.key}>
            {issue.title}
          </option>
        ))}
      </datalist>
    </>
  );
}

/**
 * The type of an issue being created from a comment: the types the person can use in the tracker's project, starting on
 * the tracker's own. Nothing is chosen (the tracker's own is used) until they've loaded.
 */
export function IssueTypeChoice({
  projectId,
  connectionId,
  value,
  onChange,
}: {
  projectId: string;
  connectionId: string;
  value: string;
  onChange: (type: string) => void;
}) {
  const [types, setTypes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pick = useRef(onChange);
  pick.current = onChange;
  useEffect(() => {
    let live = true;
    pick.current("");
    api
      .get("/api/projects/{projectId}/issue-trackers/{id}/issue-types", {
        params: { path: { projectId, id: connectionId } },
      })
      .then((found) => {
        if (!live) return;
        setTypes(found.types);
        pick.current(found.suggested ?? found.types[0] ?? "");
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Couldn't load the types.");
      });
    return () => {
      live = false;
    };
  }, [projectId, connectionId]);

  if (error) return <p className="text-xs text-muted-foreground">Created as the tracker's own type ({error}).</p>;
  if (!types || types.length === 0) return null;
  return (
    <NativeSelect aria-label="Issue type" value={value} onChange={(e) => onChange(e.target.value)}>
      {types.map((type) => (
        <NativeSelectOption key={type} value={type}>
          {type}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}
