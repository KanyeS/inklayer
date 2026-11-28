import { textEdit } from "@inklayer/docs/docMarkdown";
import { enhance } from "@inklayer/docs/enhance";
import { escapeHtml, renderMarkdown } from "@inklayer/docs/reading";
import { type ChangeEvent, type MouseEvent, useEffect, useRef, useState } from "react";
import { navigate } from "@/lib/router";
import type { DocSession } from "../collab";
import { type DocTree, docPath } from "../docsApi";
import { resolveLink } from "../links";
import { commentCard, loadComment } from "./comments";
import { setTaskChecked } from "./docViewText";
import { fillTaskLink, loadTask, openTask } from "./taskLinks";

/** How long typing (by anyone) must pause before the reading view is redrawn. */
const RERENDER_DELAY_MS = 250;

export interface DocReadingProps {
  orgId: string;
  session: DocSession;
  tree: DocTree;
  canEdit: boolean;
  onTag: (tag: string) => void;
  openLink: (target: string | null, resolvedId: string | null, newTab: boolean) => Promise<void>;
  person: (id: string) => { displayName: string; fullName: string } | undefined;
}

/** Re-renders the doc's Markdown as it changes, a moment after typing stops. */
function useRenderedHtml({ orgId, session, tree, canEdit, person }: DocReadingProps): string {
  const [html, setHtml] = useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `person` reads a ref, so it never needs a re-render
  useEffect(() => {
    let timer = 0;
    const render = () =>
      setHtml(
        renderMarkdown(session.text.toString(), {
          doc: (link) => {
            const doc = resolveLink(tree.docs, link);
            return doc ? { href: docPath(orgId, doc.id) } : null;
          },
          person,
          tickable: canEdit,
        }),
      );
    render();
    const update = () => {
      clearTimeout(timer);
      timer = window.setTimeout(render, RERENDER_DELAY_MS);
    };
    session.text.observe(update);
    return () => {
      clearTimeout(timer);
      session.text.unobserve(update);
    };
  }, [session, tree, orgId, canEdit]);
  return html;
}

/** The reading view: rendered Markdown with links, tags, ticked tasks, comment cards, maths and diagrams. */
export function DocReading(props: DocReadingProps) {
  const { orgId, session, canEdit, onTag, openLink } = props;
  const html = useRenderedHtml(props);
  const ref = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each render of the HTML
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    // Comment embeds: fill in each one's card.
    for (const el of root.querySelectorAll<HTMLElement>("[data-comment-id]")) {
      const id = el.dataset.commentId ?? "";
      void loadComment(id).then((c) => el.replaceChildren(commentCard(c, id)));
    }
    // Task links: the task's title and status.
    for (const el of root.querySelectorAll<HTMLAnchorElement>("a[data-task-key]")) {
      const key = el.dataset.taskKey ?? "";
      void loadTask(orgId, key).then((t) => fillTaskLink(el, t, key));
    }
    // Maths, diagrams and code colours.
    void enhance(root);
  }, [html]);

  // Ticking a checkbox ticks it in the doc's text, on its line, for everyone.
  const onChange = (e: ChangeEvent<HTMLDivElement>) => {
    const box = e.target as unknown as HTMLInputElement;
    if (!canEdit || !box.classList.contains("task-checkbox")) return;
    const text = session.text.toString();
    const next = setTaskChecked(text, Number(box.dataset.line), box.checked);
    const edit = next === null ? null : textEdit(text, next);
    if (!edit) return;
    session.doc.transact(() => {
      session.text.delete(edit.from, edit.to - edit.from);
      session.text.insert(edit.from, edit.insert);
    });
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a");
    if (!a) return;
    const href = a.getAttribute("href");
    if (a.dataset.tag) {
      e.preventDefault();
      onTag(a.dataset.tag);
    } else if (a.dataset.taskKey) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      void openTask(orgId, a.dataset.taskKey, false);
    } else if (a.dataset.create !== undefined) {
      e.preventDefault();
      void openLink(a.dataset.create, null, false);
    } else if (href && (a.classList.contains("doc-wikilink") || (href.startsWith("/") && !a.target))) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigate(href);
    }
  };

  return (
    <div
      ref={ref}
      className="doc-reading"
      onClick={onClick}
      onChange={onChange}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: rendered by renderMarkdown, which escapes all raw HTML
      dangerouslySetInnerHTML={{
        __html: html || `<p class="text-muted-foreground">${escapeHtml("This doc is empty.")}</p>`,
      }}
    />
  );
}
