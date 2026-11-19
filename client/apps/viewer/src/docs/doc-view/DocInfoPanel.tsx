import { headings } from "@inklayer/docs/docMarkdown";
import { Link2, MessageSquare } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { hostOf } from "@/lib/format";
import { personTitle } from "@/lib/people";
import { Link } from "@/lib/router";
import type { DocSession } from "../collab";
import { type DocInfo, docPath } from "../docsApi";
import { pathOf } from "../links";
import { headingText } from "./docViewText";

/** How long typing must pause before the outline is worked out again. */
const OUTLINE_DELAY_MS = 400;

/** The right-hand panel: docs and page comments linking here, this doc's links, and its outline. */
export function DocInfoPanel({ orgId, info, session }: { orgId: string; info: DocInfo; session: DocSession }) {
  const outline = useOutline(session);
  return (
    <aside className="doc-info-panel">
      <PanelSection icon={<Link2 className="size-4" />} title="Linked from" count={info.backlinks.length}>
        {info.backlinks.length === 0 ? (
          <Muted>No other docs link here yet.</Muted>
        ) : (
          info.backlinks.map((d) => (
            <Link key={d.id} to={docPath(orgId, d.id)} className="doc-panel-link" title={pathOf(d)}>
              {d.title}
            </Link>
          ))
        )}
      </PanelSection>

      <PanelSection
        icon={<MessageSquare className="size-4" />}
        title="Page comments linking here"
        count={info.commentBacklinks.length}
      >
        {info.commentBacklinks.length === 0 ? (
          <Muted>Write [[{info.title}]] in a page comment to link it here.</Muted>
        ) : (
          info.commentBacklinks.map((c) => <CommentBacklink key={c.annotationId} comment={c} />)
        )}
      </PanelSection>

      <PanelSection title="Links" count={info.links.length}>
        {info.links.length === 0 ? (
          <Muted>Type [[ to link another doc.</Muted>
        ) : (
          info.links.map((l) =>
            l.docId ? (
              <Link key={l.text} to={docPath(orgId, l.docId)} className="doc-panel-link">
                {l.title}
              </Link>
            ) : (
              <span
                key={l.text}
                className="block truncate px-2 py-1 text-muted-foreground"
                title="This doc doesn't exist yet"
              >
                {l.text} <span className="text-xs">(missing)</span>
              </span>
            ),
          )
        )}
      </PanelSection>

      {outline.length > 0 && (
        <PanelSection title="Outline" count={outline.length}>
          {outline.map((h) => (
            <button
              key={h.from}
              type="button"
              className="doc-outline-item"
              style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
              onClick={() => scrollToHeading(h.text)}
            >
              {h.text}
            </button>
          ))}
        </PanelSection>
      )}
    </aside>
  );
}

/** The doc's headings, kept up to date as it's edited. */
function useOutline(session: DocSession) {
  const [outline, setOutline] = useState(() => headings(session.text.toString()));
  useEffect(() => {
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setOutline(headings(session.text.toString())), OUTLINE_DELAY_MS);
    };
    session.text.observe(update);
    update();
    return () => {
      clearTimeout(timer);
      session.text.unobserve(update);
    };
  }, [session]);
  return outline;
}

function CommentBacklink({ comment: c }: { comment: DocInfo["commentBacklinks"][number] }) {
  return (
    <Link to={`/comments/${c.annotationId}`} className="block rounded-lg border px-3 py-2 hover:bg-muted">
      <span className="block text-xs text-muted-foreground">
        <span title={personTitle(c.author)}>{c.author.displayName}</span> · {c.projectName}
        {c.status === "Resolved" ? " · resolved" : ""}
      </span>
      <span className="line-clamp-3">{c.body}</span>
      {c.pageUrl && <span className="mt-1 block truncate text-xs text-muted-foreground">{hostOf(c.pageUrl)}</span>}
    </Link>
  );
}

const HEADING_ELEMENTS =
  ".doc-editor .cm-line, .doc-reading h1, .doc-reading h2, .doc-reading h3, .doc-reading h4, .doc-reading h5, .doc-reading h6";

function scrollToHeading(text: string) {
  const target = [...document.querySelectorAll<HTMLElement>(HEADING_ELEMENTS)].find(
    (el) => headingText(el.textContent ?? "") === text.trim(),
  );
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function PanelSection({
  icon,
  title,
  count,
  children,
}: {
  icon?: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mb-6">
      <h2 className="doc-panel-heading">
        {icon}
        {title}
        <span className="font-normal">{count}</span>
      </h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="px-2 text-muted-foreground">{children}</p>;
}
