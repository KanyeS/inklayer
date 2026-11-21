/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import type { FoundIssue, TrackerChoice } from "../../lib/live";
import { call } from "../call";
import { TRACKER_NAMES } from "../labels";

/** The forms under a comment for linking an existing issue or pull request, and creating one in Jira or Azure DevOps. */

/** What a parent typed in by hand looks like: an address, #12 or !12, or a key like WEB-12. */
const REFERENCE = /^(https?:\/\/\S+|[#!]?\d{1,12}|[A-Za-z][A-Za-z0-9_]*-\d{1,12})$/i;

/** Trackers that can create an issue under another. */
export const NESTING_KINDS: ReadonlySet<TrackerChoice["kind"]> = new Set<TrackerChoice["kind"]>([
  "jira",
  "azuredevops",
]);

/**
 * Finds an issue to link to the comment, by searching or by its address or number; or a pull request (GitLab: merge
 * request) in trackers that have them.
 */
export function LinkIssue({
  projectId,
  trackers,
  busy,
  onLink,
  onCancel,
}: {
  projectId: string;
  trackers: TrackerChoice[];
  busy: boolean;
  onLink: (connectionId: string, reference: string, addComment: boolean, pullRequest: boolean) => void;
  onCancel: () => void;
}) {
  const [connectionId, setConnectionId] = useState(trackers[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundIssue[] | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<FoundIssue | null>(null);
  const [addComment, setAddComment] = useState(true);
  const [pulls, setPulls] = useState(false);
  const tracker = trackers.find((t) => t.id === connectionId);
  const pullRequests = pulls && tracker?.pullRequests === true;
  const noun = pullRequests ? "pull request" : "issue";

  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      call<FoundIssue[]>({ type: "live.issueSearch", projectId, connectionId, q: query.trim(), pullRequests })
        .then((found) => {
          if (!current) return;
          setResults(found);
          setError("");
        })
        .catch((e: unknown) => {
          if (!current) return;
          setResults([]);
          setError(e instanceof Error ? e.message : "Search failed.");
        });
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [projectId, connectionId, query, pullRequests]);

  const reference = picked?.url ?? query.trim();
  const submit = (e: Event) => {
    e.preventDefault();
    if (reference) onLink(connectionId, reference, addComment, pullRequests);
  };

  return (
    <form className="link-issue" onSubmit={submit}>
      {trackers.length > 1 && (
        <select
          aria-label="Tracker"
          value={connectionId}
          onChange={(e) => {
            setConnectionId((e.currentTarget as HTMLSelectElement).value);
            setPicked(null);
          }}
        >
          {trackers.map((t) => (
            <option key={t.id} value={t.id}>
              {TRACKER_NAMES[t.kind]}: {t.name}
            </option>
          ))}
        </select>
      )}
      {tracker?.pullRequests && (
        <div className="row" role="tablist" aria-label="Link">
          {[false, true].map((pr) => (
            <button
              key={String(pr)}
              type="button"
              role="tab"
              className={pulls === pr ? "picked" : "link"}
              aria-selected={pulls === pr}
              onClick={() => {
                setPulls(pr);
                setPicked(null);
                setResults(null);
              }}
            >
              {pr ? "Pull request" : "Issue"}
            </button>
          ))}
        </div>
      )}
      <input
        type="text"
        aria-label={`Find a ${noun}`}
        placeholder={`Search titles, or paste a ${noun}'s address or number`}
        value={query}
        onInput={(e) => {
          setQuery((e.currentTarget as HTMLInputElement).value);
          setPicked(null);
        }}
      />
      {results && results.length > 0 && (
        <ul className="found" aria-label="Issues found">
          {results.map((r) => (
            <li key={r.externalId}>
              <button
                type="button"
                className={picked?.externalId === r.externalId ? "picked" : ""}
                aria-pressed={picked?.externalId === r.externalId}
                onClick={() => setPicked(r)}
              >
                <strong>{r.key}</strong> {r.title}
                {r.recent && <span className="muted"> · recent</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {results?.length === 0 && !error && <p className="muted">No open {noun}s match.</p>}
      {error && <p className="error">{error}</p>}
      <label className="row muted">
        <input
          type="checkbox"
          checked={addComment}
          onChange={(e) => setAddComment((e.currentTarget as HTMLInputElement).checked)}
        />
        {pullRequests ? "List it in the pull request's Inklayer summary" : "Add this comment to the issue"}
      </label>
      <div className="row">
        <button type="submit" disabled={busy || !reference}>
          {picked ? `Link ${picked.key}` : "Link"}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Creating an issue in Jira or Azure DevOps: its type, from the types the user can use in the project (starting on the
 * tracker's own), and optionally an issue to create it under (a sub-task, a child work item).
 */
export function CreateTypedIssue({
  projectId,
  tracker,
  busy,
  onCreate,
  onCancel,
}: {
  projectId: string;
  tracker: TrackerChoice;
  busy: boolean;
  onCreate: (issueType: string | undefined, parent: string | undefined) => void;
  onCancel: () => void;
}) {
  const [types, setTypes] = useState<string[] | null>(null);
  const [issueType, setIssueType] = useState("");
  const [typesError, setTypesError] = useState("");
  const [parent, setParent] = useState("");
  const [parents, setParents] = useState<FoundIssue[]>([]);
  const [picked, setPicked] = useState<FoundIssue | null>(null);

  useEffect(() => {
    let current = true;
    call<{ types: string[]; suggested?: string | null }>({
      type: "live.issueTypes",
      projectId,
      connectionId: tracker.id,
    })
      .then((found) => {
        if (!current) return;
        setTypes(found.types);
        setIssueType(found.suggested ?? found.types[0] ?? "");
      })
      .catch((e: unknown) => {
        if (!current) return;
        setTypes([]);
        setTypesError(e instanceof Error ? e.message : "Couldn't load the types.");
      });
    return () => {
      current = false;
    };
  }, [projectId, tracker.id]);

  // Suggestions for the parent as it's typed.
  useEffect(() => {
    const q = parent.trim();
    if (!q) {
      setParents([]);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      call<FoundIssue[]>({ type: "live.issueSearch", projectId, connectionId: tracker.id, q })
        .then((found) => current && setParents(found))
        .catch(() => current && setParents([]));
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [projectId, tracker.id, parent]);

  const under = tracker.kind === "jira" ? "Sub-task of" : "Child of";
  // The parent: one picked from the list, or a number, key or address typed in. Other words are only a search.
  const typed = parent.trim();
  const reference = picked?.url ?? (REFERENCE.test(typed) ? typed : null);
  const unclear = typed.length > 0 && !reference;
  const submit = (e: Event) => {
    e.preventDefault();
    if (!unclear) onCreate(issueType || undefined, reference ?? undefined);
  };

  return (
    <form className="link-issue" onSubmit={submit}>
      <div className="row">
        <span className="muted">Type</span>
        {types && types.length > 0 ? (
          <select
            aria-label="Issue type"
            value={issueType}
            onChange={(e) => setIssueType((e.currentTarget as HTMLSelectElement).value)}
          >
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted">{types ? "The tracker's own" : "Loading…"}</span>
        )}
      </div>
      {typesError && <p className="error">{typesError}</p>}
      {picked ? (
        <div className="row">
          <span className="muted">{under}</span>
          <strong>{picked.key}</strong> {picked.title}
          <button
            type="button"
            className="link"
            onClick={() => {
              setPicked(null);
              setParent("");
            }}
          >
            Change
          </button>
        </div>
      ) : (
        <input
          type="text"
          aria-label={`${under} (optional)`}
          placeholder={`${under} (optional): search, or a key, #number or address`}
          value={parent}
          onInput={(e) => setParent((e.currentTarget as HTMLInputElement).value)}
        />
      )}
      {!picked && parents.length > 0 && (
        <ul className="found" aria-label="Parents found">
          {parents.map((p) => (
            <li key={p.externalId}>
              <button type="button" onClick={() => setPicked(p)}>
                <strong>{p.key}</strong> {p.title}
              </button>
            </li>
          ))}
        </ul>
      )}
      {unclear && <p className="muted">Pick the parent from the list, or give its number or address.</p>}
      <div className="row">
        <button type="submit" disabled={busy || !types || unclear}>
          Create in {TRACKER_NAMES[tracker.kind]}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
