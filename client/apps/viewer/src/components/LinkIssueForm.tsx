import type { FoundIssue } from "@inklayer/api";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Input } from "@inklayer/ui/components/input";
import { cn } from "@inklayer/ui/lib/utils";
import { CircleCheck, CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { ErrorText } from "@/components/Layout";
import { api } from "@/lib/api";
import { useAction } from "@/lib/query";

/** Open, closed or merged; pull requests get their own icons. */
export function StateIcon({
  state,
  pullRequest,
  className,
}: {
  state: string;
  pullRequest?: boolean;
  className?: string;
}) {
  if (!pullRequest) {
    return state === "open" ? (
      <CircleDot className={cn(className, "text-green-600")} />
    ) : (
      <CircleCheck className={cn(className, "text-purple-600")} />
    );
  }
  if (state === "merged") return <GitMerge className={cn(className, "text-purple-600")} />;
  if (state === "closed") return <GitPullRequestClosed className={cn(className, "text-red-600")} />;
  return <GitPullRequest className={cn(className, "text-green-600")} />;
}

/**
 * Finds an issue that already exists (by title, or a pasted address or number) and links it to the comment; or, with
 * `pullRequests`, a pull request (GitLab: merge request), whose merging resolves the comment.
 */
export function LinkIssueForm({
  commentId,
  projectId,
  connectionId,
  trackerName,
  pullRequests = false,
  onDone,
}: {
  commentId: string;
  projectId: string;
  connectionId: string;
  trackerName: string;
  pullRequests?: boolean;
  onDone: () => void;
}) {
  const noun = pullRequests ? "pull request" : "issue";
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
          params: { path: { projectId, id: connectionId }, query: { q: query.trim(), pullRequests } },
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
  }, [query, projectId, connectionId, pullRequests]);

  const link = async (e: FormEvent) => {
    e.preventDefault();
    const reference = picked?.url ?? query.trim();
    if (!reference) return;
    const linked = await run(() =>
      api.post("/api/annotations/{annotationId}/issues/link", {
        params: { path: { annotationId: commentId } },
        body: { connectionId, reference, addComment, pullRequest: pullRequests },
      }),
    );
    if (linked.ok) onDone();
  };

  return (
    <form onSubmit={link} className="flex flex-col gap-2">
      <Input
        aria-label={`Find a ${noun}`}
        placeholder={`Search titles, or paste the ${noun}'s address or number`}
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
              <StateIcon state={r.state} pullRequest={pullRequests} className="size-3.5 shrink-0" />
              <span className="shrink-0 font-medium">{r.key}</span>
              <span className="min-w-0 truncate">{r.title}</span>
              {r.recent && (
                <Badge variant="outline" className="ml-auto shrink-0" title="Linked to a comment recently">
                  Recent
                </Badge>
              )}
            </button>
          </li>
        ))}
      </ul>
      {results?.length === 0 && !searchError && <p className="text-xs text-muted-foreground">No open {noun}s match.</p>}
      <ErrorText error={searchError} />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={addComment} onCheckedChange={(on) => setAddComment(on === true)} />
        {pullRequests ? "List this comment in the pull request's Inklayer summary" : "Add this comment to the issue"}
      </label>
      <p className="text-xs text-muted-foreground">
        {pullRequests
          ? "Merging the pull request resolves the comment. Inklayer keeps one comment on it listing what's linked."
          : "The issue's comments show in this thread, and closing it resolves the comment."}
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
