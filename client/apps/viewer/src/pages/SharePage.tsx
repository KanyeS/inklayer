import { useMemo } from "react";
import { Eye, FileText, MessageSquare } from "lucide-react";
import { Badge } from "@inklayer/ui/components/badge";
import { ApiError, get } from "@/lib/api";
import { dateTime, hostOf, timeAgo } from "@/lib/format";
import { useAsync } from "@/lib/useAsync";
import { renderMarkdown } from "@/docs/reading";

interface PublicReply {
  author: string;
  body: string;
  createdAt: string;
}

interface PublicComment {
  id: string;
  body: string;
  status: "Open" | "Resolved";
  author: string;
  createdAt: string;
  hasScreenshot: boolean;
  replies: PublicReply[];
}

interface PublicShare {
  kind: "page" | "project" | "doc";
  title: string;
  expiresAt: string | null;
  pages: { pageUrl: string; comments: PublicComment[] }[] | null;
  doc: { markdown: string; updatedAt: string; links: { key: string; token: string }[] } | null;
}

/**
 * What a share link shows, to anyone with it: a page's or project's comments, or a doc. Read-only, and no sign-in: this
 * page never asks the server who you are.
 */
export function SharePage({ token }: { token: string }) {
  const share = useAsync(() => get<PublicShare>(`/api/public/shares/${encodeURIComponent(token)}`), [token]);

  return (
    <div className="min-h-svh bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-6 py-3 text-sm">
          <span className="font-heading font-semibold">Inklayer</span>
          <Badge variant="secondary"><Eye data-icon="inline-start" />Read-only</Badge>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-8">
        {share.error ? (
          <div>
            <h1 className="font-heading text-2xl font-bold">This link doesn't work</h1>
            <p className="mt-2 text-muted-foreground">
              {share.error instanceof ApiError && share.error.status === 404 ? "It may have been turned off or expired. Ask whoever sent it for a new one." : share.error.message}
            </p>
          </div>
        ) : !share.data ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : share.data.doc ? (
          <SharedDoc title={share.data.title} doc={share.data.doc} />
        ) : (
          <SharedComments token={token} share={share.data} />
        )}
        {share.data?.expiresAt && <p className="mt-10 text-xs text-muted-foreground">This link stops working {dateTime(share.data.expiresAt)}.</p>}
      </main>
    </div>
  );
}

function SharedDoc({ title, doc }: { title: string; doc: NonNullable<PublicShare["doc"]> }) {
  const html = useMemo(() => renderMarkdown(doc.markdown, {
    guest: true,
    // Links to other public docs lead to their own share links; anything else is plain text.
    doc: (link) => {
      const key = link.target?.toLowerCase();
      const found = doc.links.find((l) => l.key === key);
      return found ? { href: `/s/${encodeURIComponent(found.token)}${link.heading ? `#${encodeURIComponent(link.heading)}` : ""}` } : null;
    },
  }), [doc]);

  return (
    <article>
      <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><FileText className="size-4" />Doc · updated {timeAgo(doc.updatedAt)}</p>
      <h1 className="mb-6 font-heading text-3xl font-bold">{title}</h1>
      {/* eslint-disable-next-line react/no-danger -- rendered by renderMarkdown, which escapes all raw HTML */}
      <div className="doc-reading" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

/** [[Doc|alias]] and [[comment:id|alias]] in comments, as the text they show. */
const plain = (text: string) => text.replace(/\[\[([^[\]\n]+?)\]\]/g, (_, inner: string) => {
  const [target, alias] = inner.split("|");
  return alias ?? (target?.startsWith("comment:") ? "a comment" : target ?? "");
});

function SharedComments({ token, share }: { token: string; share: PublicShare }) {
  const pages = share.pages ?? [];
  const count = pages.reduce((n, p) => n + p.comments.length, 0);
  return (
    <div>
      <p className="mb-2 flex items-center gap-2 text-sm text-muted-foreground"><MessageSquare className="size-4" />{share.kind === "page" ? "Comments on a page" : "Comments"} · {count}</p>
      <h1 className="mb-6 font-heading text-3xl font-bold">{share.title}</h1>
      {count === 0 && <p className="text-muted-foreground">No comments to show.</p>}
      {pages.map((page) => (
        <section key={page.pageUrl} className="mb-10">
          <h2 className="mb-3 truncate font-heading text-base font-semibold">
            <a href={page.pageUrl} target="_blank" rel="noopener noreferrer" className="hover:underline" title={page.pageUrl}>{hostOf(page.pageUrl)}{pathOf(page.pageUrl)}</a>
          </h2>
          <ol className="space-y-4">
            {page.comments.map((c) => (
              <li key={c.id} className="rounded-2xl border p-4">
                <p className="mb-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{c.author}</span>
                  <span title={dateTime(c.createdAt)}>{timeAgo(c.createdAt)}</span>
                  {c.status === "Resolved" && <Badge variant="secondary">Resolved</Badge>}
                </p>
                <p className="whitespace-pre-wrap">{plain(c.body)}</p>
                {c.hasScreenshot && (
                  <a href={`/api/public/shares/${encodeURIComponent(token)}/screenshots/${c.id}`} target="_blank" rel="noopener noreferrer" className="mt-3 block">
                    <img src={`/api/public/shares/${encodeURIComponent(token)}/screenshots/${c.id}`} alt="Screenshot when this was commented" loading="lazy" className="max-h-72 rounded-xl border object-contain" />
                  </a>
                )}
                {c.replies.length > 0 && (
                  <ul className="mt-3 space-y-2 border-l-2 pl-3">
                    {c.replies.map((r, i) => (
                      <li key={i} className="text-sm">
                        <span className="font-medium">{r.author}</span> <span className="text-muted-foreground" title={dateTime(r.createdAt)}>{timeAgo(r.createdAt)}</span>
                        <p className="whitespace-pre-wrap">{plain(r.body)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
