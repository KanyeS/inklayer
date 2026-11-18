import { useState, type FormEvent } from "react";
import { Check, Copy, ExternalLink, FileText, MessageSquare } from "lucide-react";
import { commentParts, openOnPageUrl } from "@inklayer/overlay";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Textarea } from "@inklayer/ui/components/textarea";
import { ErrorText, Loading, Page } from "@/components/Layout";
import { useMe } from "@/App";
import { ApiError, del, get, post } from "@/lib/api";
import { dateTime, hostOf, timeAgo } from "@/lib/format";
import { Link } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";
import { personTitle } from "@/lib/people";

interface CommentDetail {
  id: string;
  organizationId: string;
  projectId: string;
  projectName: string;
  pageUrl: string;
  body: string;
  status: "Open" | "Resolved";
  author: { id: string; displayName: string; fullName?: string | null; role?: string | null };
  createdAt: string;
  docLinks: { text: string; docId: string | null; title: string | null }[];
  mentionedIn: { docId: string; title: string }[];
  replies: Reply[];
  canReply: boolean;
}

interface Reply {
  id: string;
  body: string;
  author: { id: string; displayName: string; fullName?: string | null; role?: string | null };
  createdAt: string;
  version: number;
  canDelete: boolean;
}

/**
 * One page comment, for links from docs (and "Copy link" in the extension): what it says, where it is, and which docs
 * mention it. "Open on the page" opens the page with that comment selected, if the extension is installed.
 */
export function CommentPage({ commentId }: { commentId: string }) {
  const { me } = useMe();
  const comment = useAsync(() => get<CommentDetail>(`/api/annotations/${commentId}`), [commentId]);
  const [copied, setCopied] = useState(false);

  if (comment.error) {
    return (
      <Page>
        <ErrorText error={comment.error instanceof ApiError && comment.error.status === 404 ? new Error("This comment was deleted, or it's in a project you can't see.") : comment.error} />
      </Page>
    );
  }
  if (!comment.data) return <Page><Loading /></Page>;
  const c = comment.data;
  const docHref = (docId: string) => `/orgs/${c.organizationId}/docs/${docId}`;
  // With docs turned off, [[links]] are just text.
  const linked = (text: string) => !me.features.docs ? text : commentParts(text, c.docLinks).map((part, i) => (
    "text" in part ? <span key={i}>{part.text}</span>
      : part.docId ? <Link key={i} to={docHref(part.docId)} className="text-primary underline underline-offset-4">{part.shown}</Link>
      : <span key={i} className="text-muted-foreground" title="This doc doesn't exist yet">{part.shown}</span>
  ));

  const copy = async () => {
    await navigator.clipboard.writeText(`${location.origin}/comments/${c.id}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Page className="max-w-2xl">
      <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
        <MessageSquare className="size-4" />Page comment · <Link to={`/projects/${c.projectId}`} className="hover:underline">{c.projectName}</Link>
        {c.status === "Resolved" && <Badge variant="secondary">Resolved</Badge>}
      </p>
      <article className="rounded-3xl border p-6">
        <p className="mb-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground" title={personTitle(c.author)}>{c.author.displayName}</span> · <span title={dateTime(c.createdAt)}>{timeAgo(c.createdAt)}</span>
        </p>
        <p className="text-lg whitespace-pre-wrap">{linked(c.body)}</p>
        <p className="mt-4 truncate text-sm text-muted-foreground" title={c.pageUrl}>{hostOf(c.pageUrl)}{safePath(c.pageUrl)}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button nativeButton={false} render={<a href={openOnPageUrl(c.pageUrl, c.id)} target="_blank" rel="noopener noreferrer" />}>
            <ExternalLink data-icon="inline-start" />Open on the page
          </Button>
          <Button variant="outline" onClick={() => void copy()}>
            {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}{copied ? "Copied" : "Copy link"}
          </Button>
        </div>
        {me.features.docs && <p className="mt-3 text-xs text-muted-foreground">Paste the link into a doc to link this comment there.</p>}
      </article>

      <h2 className="mt-8 mb-3 font-heading text-base font-semibold">Replies</h2>
      {c.replies.length === 0 && <p className="text-sm text-muted-foreground">No replies yet.</p>}
      <ol className="space-y-3">
        {c.replies.map((r) => (
          <li key={r.id} className="rounded-2xl border px-4 py-3">
            <p className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground" title={personTitle(r.author)}>{r.author.displayName}</span>
              <span title={dateTime(r.createdAt)}>{timeAgo(r.createdAt)}</span>
              {r.canDelete && (
                <Button variant="link" size="sm" className="ml-auto h-auto px-0 text-destructive" onClick={async () => { await del(`/api/replies/${r.id}?version=${r.version}`); await comment.reload(); }}>Delete</Button>
              )}
            </p>
            <p className="whitespace-pre-wrap">{linked(r.body)}</p>
          </li>
        ))}
      </ol>
      {c.canReply && <ReplyForm commentId={c.id} onSent={comment.reload} />}

      {me.features.docs && <h2 className="mt-8 mb-3 font-heading text-base font-semibold">Mentioned in</h2>}
      {!me.features.docs ? null : c.mentionedIn.length === 0 ? (
        <p className="text-sm text-muted-foreground">No docs link this comment yet.</p>
      ) : (
        <ul className="space-y-1">
          {c.mentionedIn.map((d) => (
            <li key={d.docId}>
              <Link to={docHref(d.docId)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted"><FileText className="size-4 text-muted-foreground" />{d.title}</Link>
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

function ReplyForm({ commentId, onSent }: { commentId: string; onSent: () => Promise<void> }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await post(`/api/annotations/${commentId}/replies`, { body });
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
      <Textarea
        placeholder="Reply… ([[ links a doc; Ctrl+Enter sends)"
        aria-label="Reply"
        value={body}
        maxLength={10000}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
        }}
      />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !body.trim()}>Reply</Button>
        <ErrorText error={error} />
      </div>
    </form>
  );
}
