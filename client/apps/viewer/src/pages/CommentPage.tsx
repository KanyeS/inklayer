import type { AnnotationContextResponse } from "@inklayer/api";
import { commentParts, openOnPageUrl } from "@inklayer/overlay";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Check, Copy, ExternalLink, FileText, MessageSquare } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useMe } from "@/App";
import { CreateIssueButton, IssueChips } from "@/components/Issues";
import { ErrorText, Loading, Page } from "@/components/Layout";
import { MentionTextarea, type MentionTextareaHandle } from "@/components/MentionTextarea";
import { ApiError, api } from "@/lib/api";
import { dateTime, hostOf, timeAgo } from "@/lib/format";
import { personTitle } from "@/lib/people";
import { Link } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";

type PageContext = AnnotationContextResponse;

/**
 * One page comment, for links from docs (and "Copy link" in the extension): what it says, where it is, and which docs
 * mention it. "Open on the page" opens the page with that comment selected, if the extension is installed.
 */
export function CommentPage({ commentId }: { commentId: string }) {
  const { me } = useMe();
  const comment = useAsync(
    () => api.get("/api/annotations/{annotationId}", { params: { path: { annotationId: commentId } } }),
    [commentId],
  );
  const [copied, setCopied] = useState(false);

  if (comment.error) {
    return (
      <Page>
        <ErrorText
          error={
            comment.error instanceof ApiError && comment.error.status === 404
              ? new Error("This comment was deleted, or it's in a project you can't see.")
              : comment.error
          }
        />
      </Page>
    );
  }
  if (!comment.data)
    return (
      <Page>
        <Loading />
      </Page>
    );
  const c = comment.data;
  const docHref = (docId: string) => `/orgs/${c.organizationId}/docs/${docId}`;
  const linked = (text: string) =>
    commentParts(text, c.docLinks, c.people ?? []).map((part, i) =>
      "text" in part ? (
        <span key={i}>{part.text}</span>
      ) : "mention" in part ? (
        <span
          key={i}
          className="rounded bg-primary/10 px-0.5 font-semibold text-primary"
          title={part.fullName ?? part.mention}
        >
          @{part.mention}
        </span>
      ) : // With docs turned off, [[links]] are just text.
      !me.features.docs ? (
        <span key={i}>[[{part.shown}]]</span>
      ) : part.docId ? (
        <Link key={i} to={docHref(part.docId)} className="text-primary underline underline-offset-4">
          {part.shown}
        </Link>
      ) : (
        <span key={i} className="text-muted-foreground" title="This doc doesn't exist yet">
          {part.shown}
        </span>
      ),
    );

  const copy = async () => {
    await navigator.clipboard.writeText(`${location.origin}/comments/${c.id}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Page className="max-w-2xl">
      <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        <MessageSquare className="size-4" />
        Page comment ·{" "}
        <Link to={`/projects/${c.projectId}`} className="hover:underline">
          {c.projectName}
        </Link>
        {c.status === "Resolved" && <Badge variant="secondary">Resolved</Badge>}
      </p>
      <article className="rounded-3xl border p-6">
        <p className="mb-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground" title={personTitle(c.author)}>
            {c.author.displayName}
          </span>{" "}
          · <span title={dateTime(c.createdAt)}>{timeAgo(c.createdAt)}</span>
        </p>
        <p className="text-lg whitespace-pre-wrap">{linked(c.body)}</p>
        {me.features.bugContext && c.hasScreenshot && (
          <a
            href={`/api/annotations/${c.id}/screenshot`}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 block"
          >
            <img
              src={`/api/annotations/${c.id}/screenshot`}
              alt="Screenshot when this was commented"
              className="max-h-96 rounded-xl border object-contain"
            />
          </a>
        )}
        {me.features.bugContext && c.context && <PageDetails context={c.context} />}
        {me.features.issueTrackers && <IssueChips issues={c.issues ?? []} />}
        <p className="mt-4 truncate text-sm text-muted-foreground" title={c.pageUrl}>
          {hostOf(c.pageUrl)}
          {safePath(c.pageUrl)}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button
            nativeButton={false}
            render={<a href={openOnPageUrl(c.pageUrl, c.id)} target="_blank" rel="noopener noreferrer" />}
          >
            <ExternalLink data-icon="inline-start" />
            Open on the page
          </Button>
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
            {copied ? "Copied" : "Copy link"}
          </Button>
          {me.features.issueTrackers && c.canReply && (
            <CreateIssueButton commentId={c.id} projectId={c.projectId} onCreated={comment.reload} />
          )}
        </div>
        {me.features.docs && (
          <p className="mt-3 text-xs text-muted-foreground">Paste the link into a doc to link this comment there.</p>
        )}
      </article>

      <h2 className="mt-8 mb-3 font-heading text-base font-semibold">Replies</h2>
      {c.replies.length === 0 && <p className="text-sm text-muted-foreground">No replies yet.</p>}
      <ol className="space-y-3">
        {c.replies.map((r) => (
          <li key={r.id} className="rounded-2xl border px-4 py-3">
            <p className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground" title={personTitle(r.author)}>
                {r.author.displayName}
              </span>
              <span title={dateTime(r.createdAt)}>{timeAgo(r.createdAt)}</span>
              {r.canDelete && (
                <Button
                  variant="link"
                  size="sm"
                  className="ml-auto h-auto px-0 text-destructive"
                  onClick={async () => {
                    await api.delete("/api/replies/{replyId}", {
                      params: { path: { replyId: r.id }, query: { version: r.version } },
                    });
                    await comment.reload();
                  }}
                >
                  Delete
                </Button>
              )}
            </p>
            <p className="whitespace-pre-wrap">{linked(r.body)}</p>
          </li>
        ))}
      </ol>
      {c.canReply && <ReplyForm commentId={c.id} orgId={c.organizationId} onSent={comment.reload} />}

      {me.features.docs && <h2 className="mt-8 mb-3 font-heading text-base font-semibold">Mentioned in</h2>}
      {!me.features.docs ? null : c.mentionedIn.length === 0 ? (
        <p className="text-sm text-muted-foreground">No docs link this comment yet.</p>
      ) : (
        <ul className="space-y-1">
          {c.mentionedIn.map((d) => (
            <li key={d.docId}>
              <Link to={docHref(d.docId)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted">
                <FileText className="size-4 text-muted-foreground" />
                {d.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function ReplyForm({ commentId, orgId, onSent }: { commentId: string; orgId: string; onSent: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const box = useRef<MentionTextareaHandle>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api.post("/api/annotations/{annotationId}/replies", {
        params: { path: { annotationId: commentId } },
        body: { body: box.current?.encoded() ?? body },
      });
      setBody("");
      setError(null);
      await onSent();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="mt-4 flex flex-col gap-2" onSubmit={send}>
      <MentionTextarea
        ref={box}
        orgId={orgId}
        placeholder="Reply… (@ mentions someone; Ctrl+Enter sends)"
        aria-label="Reply"
        value={body}
        maxLength={10000}
        onValueChange={setBody}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
        }}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !body.trim()}>
          Reply
        </Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}

/** Browser, window size, the element, and the page's console errors and failed requests when this was commented. */
function PageDetails({ context: c }: { context: PageContext }) {
  return (
    <details className="mt-4 rounded-xl border px-4 py-3 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        Page details: {c.browser} · {c.os} · {c.viewportWidth}×{c.viewportHeight} @{c.devicePixelRatio}x
        {c.zoom && Math.abs(c.zoom - 1) > 0.01 ? ` · ${Math.round(c.zoom * 100)}% zoom` : ""}
        {c.console.length > 0 && ` · ${c.console.length} console message${c.console.length === 1 ? "" : "s"}`}
        {c.network.length > 0 && ` · ${c.network.length} failed request${c.network.length === 1 ? "" : "s"}`}
      </summary>
      {c.selector && (
        <p className="mt-3">
          <span className="text-muted-foreground">Element:</span> <code className="break-all">{c.selector}</code>
        </p>
      )}
      {c.elementHtml && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-2 text-xs whitespace-pre-wrap">
          {c.elementHtml}
        </pre>
      )}
      {c.console.length > 0 && (
        <ul className="mt-3 space-y-1">
          {c.console.map((e, i) => (
            <li key={i} className={e.level === "error" ? "text-destructive" : ""}>
              <code>{e.level}</code> {e.message}
            </li>
          ))}
        </ul>
      )}
      {c.network.length > 0 && (
        <ul className="mt-3 space-y-1">
          {c.network.map((n, i) => (
            <li key={i}>
              <code>{n.method}</code> <span className="break-all">{n.url}</span> → {n.status || "failed"}
              {n.ms ? ` (${n.ms} ms)` : ""}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
