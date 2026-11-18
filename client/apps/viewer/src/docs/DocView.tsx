import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { BookOpen, History, Link2, MessageSquare, PenLine, Trash2 } from "lucide-react";
import { PresenceLayer } from "@inklayer/overlay";
import { cn } from "@inklayer/ui/lib/utils";
import { Badge } from "@inklayer/ui/components/badge";
import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText, Loading } from "@/components/Layout";
import { dateTime, hostOf, timeAgo } from "@/lib/format";
import { Link, navigate } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";
import { DocSession, type AwarenessUser } from "./collab";
import { headings } from "./docMarkdown";
import { docPath, docsApi, type CommentInfo, type DocInfo, type DocRevision, type DocTree } from "./docsApi";
import { createEditor, type DocEditor } from "./editor";
import { createFromLink, pathOf, resolveLink, rewriteLinks } from "./links";
import { escapeHtml, renderMarkdown } from "./reading";

type Mode = "edit" | "read";

/** Comments linked from docs, loaded once per page view. Null: deleted, or in a project the reader can't see. */
const commentCache = new Map<string, Promise<CommentInfo | null>>();
export function loadComment(id: string): Promise<CommentInfo | null> {
  let entry = commentCache.get(id);
  if (!entry) {
    entry = docsApi.comment(id).catch(() => null);
    commentCache.set(id, entry);
  }
  return entry;
}

export function DocView({ orgId, docId, tree, onTreeChanged, onTag }: {
  orgId: string;
  docId: string;
  tree: DocTree;
  onTreeChanged: () => Promise<void>;
  onTag: (tag: string) => void;
}) {
  const info = useAsync(() => docsApi.doc(docId), [docId]);
  const [session, setSession] = useState<DocSession | null>(null);
  const [mode, setMode] = useState<Mode>(tree.canEdit ? "edit" : "read");
  const [historyOpen, setHistoryOpen] = useState(false);

  // One live session per doc view: open on mount, save and leave on unmount.
  useEffect(() => {
    const s = new DocSession(docId);
    setSession(s);
    void s.open();
    return () => {
      void s.close();
    };
  }, [docId]);

  // Links, backlinks and tags are worked out by the server from saved text: refresh them every so often.
  useEffect(() => {
    const timer = window.setInterval(() => document.visibilityState === "visible" && void info.reload(), 15_000);
    return () => window.clearInterval(timer);
  }, [info.reload]);

  const snapshot = useSessionState(session);
  const canEdit = snapshot?.canEdit ?? false;
  useEffect(() => {
    if (snapshot && !snapshot.canEdit && mode === "edit" && snapshot.loaded) setMode("read");
  }, [snapshot, mode]);

  if (info.error) return <div className="p-6"><ErrorText error={info.error} /></div>;
  if (!info.data || !session) return <div className="p-6"><Loading /></div>;

  return (
    <>
      <main className="min-w-0 px-6 pt-6 pb-10 md:px-10 lg:px-16">
        <div className="mx-auto max-w-3xl">
          <Header orgId={orgId} info={info.data} tree={tree} session={session} mode={mode} setMode={setMode} canEdit={canEdit}
            onRenamed={async () => { await info.reload(); await onTreeChanged(); }}
            onHistory={() => setHistoryOpen(true)} />
          {!snapshot?.loaded ? (
            snapshot?.status === "offline" ? <ErrorText error={new Error(snapshot.error || "Can't reach the server. Retrying…")} /> : <Loading />
          ) : (
            <Body orgId={orgId} session={session} tree={tree} mode={mode} canEdit={canEdit} commentLinks={info.data.commentLinks} onTag={onTag} onTreeChanged={onTreeChanged} />
          )}
        </div>
      </main>
      <InfoPanel orgId={orgId} info={info.data} session={session} onTag={onTag} />
      <HistoryDialog docId={docId} session={session} canEdit={canEdit} open={historyOpen} onOpenChange={setHistoryOpen} />
    </>
  );
}

/** Re-renders when the session's status, people or access change. */
function useSessionState(session: DocSession | null) {
  const version = useRef(0);
  const subscribe = useCallback((listener: () => void) => {
    if (!session) return () => undefined;
    return session.subscribe(() => {
      version.current++;
      listener();
    });
  }, [session]);
  const v = useSyncExternalStore(subscribe, () => version.current);
  return useMemo(() => (session ? { status: session.status, canEdit: session.canEdit, loaded: session.loaded, error: session.error, peers: [...session.peers.values()], v } : null), [session, v]);
}

/* ------------------------------------------------------------------ title and toolbar */

function Header({ orgId, info, tree, session, mode, setMode, canEdit, onRenamed, onHistory }: {
  orgId: string;
  info: DocInfo;
  tree: DocTree;
  session: DocSession;
  mode: Mode;
  setMode: (mode: Mode) => void;
  canEdit: boolean;
  onRenamed: () => Promise<void>;
  onHistory: () => void;
}) {
  const [title, setTitle] = useState(info.title);
  const [error, setError] = useState<Error | null>(null);
  const state = useSessionState(session);
  useEffect(() => setTitle(info.title), [info.title]);

  const rename = async () => {
    const next = title.trim();
    if (!next || next === info.title) {
      setTitle(info.title);
      return;
    }
    try {
      const result = await docsApi.update(info.id, { version: info.version, title: next });
      await rewriteLinks(result.relinkDocs, [{ from: info, to: { folder: info.folder, title: result.doc.title } }]);
      setError(null);
      await onRenamed();
    } catch (e) {
      setError(e as Error);
      setTitle(info.title);
    }
  };

  const remove = async () => {
    try {
      await docsApi.delete(info.id, info.version);
      navigate(`/orgs/${orgId}/docs`);
    } catch (e) {
      setError(e as Error);
    }
  };

  const status = state?.status ?? "connecting";
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="truncate">{info.folder ? info.folder.split("/").join(" / ") : "Docs"}</span>
        <div className="flex items-center gap-1">
          <span className={cn("mr-2 inline-flex items-center gap-1.5 text-xs", status === "live" ? "text-emerald-600 dark:text-emerald-400" : "")}>
            <span className={cn("size-2 rounded-full", status === "live" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-muted-foreground")} />
            {status === "live" ? (canEdit ? "Live · saved automatically" : "Live · read only") : status === "connecting" ? "Connecting…" : status === "closed" ? "Closed" : "Offline · edits kept"}
          </span>
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setMode(mode === "edit" ? "read" : "edit")} title={mode === "edit" ? "Reading view" : "Edit"}>
              {mode === "edit" ? <BookOpen data-icon="inline-start" /> : <PenLine data-icon="inline-start" />}{mode === "edit" ? "Read" : "Edit"}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onHistory}><History data-icon="inline-start" />History</Button>
          {canEdit && (
            <ConfirmButton title={`Delete "${info.title}"?`} description="Links to it will show as missing. Its history is kept." confirmLabel="Delete doc" onConfirm={() => void remove()}>
              <Trash2 />
            </ConfirmButton>
          )}
        </div>
      </div>
      <input
        className="mt-2 w-full bg-transparent font-heading text-3xl font-bold tracking-tight outline-none placeholder:text-muted-foreground disabled:opacity-100"
        value={title}
        disabled={!canEdit}
        aria-label="Title"
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setTitle(info.title);
            e.currentTarget.blur();
          }
        }}
      />
      {info.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{info.tags.map((t) => <Badge key={t} variant="secondary">#{t}</Badge>)}</div>}
      <p className="mt-1 text-xs text-muted-foreground">
        {info.updatedBy ? `Edited by ${info.updatedBy.displayName} ${timeAgo(info.updatedAt)}` : `Created ${timeAgo(info.createdAt)}`}
      </p>
      <ErrorText error={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ the text */

function Body({ orgId, session, tree, mode, canEdit, commentLinks, onTag, onTreeChanged }: {
  orgId: string;
  session: DocSession;
  tree: DocTree;
  mode: Mode;
  canEdit: boolean;
  commentLinks: string[];
  onTag: (tag: string) => void;
  onTreeChanged: () => Promise<void>;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<DocEditor | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const labels = useRef(new Map<string, string>());

  const openLink = useCallback(async (target: string | null, resolvedId: string | null, newTab: boolean) => {
    let id = resolvedId;
    if (!id && target && canEdit) {
      id = (await createFromLink(orgId, target)).id;
      await onTreeChanged();
    }
    if (!id) return;
    if (newTab) window.open(docPath(orgId, id), "_blank", "noopener");
    else navigate(docPath(orgId, id));
  }, [orgId, canEdit, onTreeChanged]);

  // Labels for comment chips.
  useEffect(() => {
    for (const id of commentLinks) {
      void loadComment(id).then((c) => {
        labels.current.set(id, c ? `${c.author.displayName}: ${c.body.slice(0, 60)}${c.body.length > 60 ? "…" : ""}` : "Comment you can't see");
        editorRef.current?.refreshChips();
      });
    }
  }, [commentLinks]);

  // The editor, with others' carets and pointers.
  useEffect(() => {
    if (mode !== "edit" || !host.current) return;
    const editor = createEditor(host.current, session, {
      titles: () => treeRef.current.docs,
      openLink: (link, newTab) => void openLink(link.target, resolveLink(treeRef.current.docs, link)?.id ?? null, newTab),
      openComment: (id) => navigate(`/comments/${id}`),
      commentLabel: (id) => labels.current.get(id),
      onPointer: (pointer) => session.awareness.setLocalStateField("pointer", pointer),
    });
    editorRef.current = editor;
    return () => {
      session.awareness.setLocalStateField("pointer", null);
      editor.destroy();
      editorRef.current = null;
    };
  }, [mode, session, openLink]);

  useEffect(() => editorRef.current?.setEditable(canEdit), [canEdit]);

  usePresence(session, editorRef);

  if (mode === "read") return <Reading orgId={orgId} session={session} tree={tree} onTag={onTag} openLink={openLink} />;
  return <div ref={host} className="doc-editor min-h-[50vh]" />;
}

/** Others' pointers and the avatar pill, drawn with the same layer as live cursors on web pages. */
function usePresence(session: DocSession, editorRef: React.RefObject<DocEditor | null>) {
  useEffect(() => {
    const layer = new PresenceLayer(document);
    const sync = () => {
      layer.setStatus(session.status === "live" ? "live" : session.status === "connecting" ? "connecting" : "offline", session.error);
      layer.setPeers([...session.peers.values()]);
      place();
    };
    const place = () => {
      const view = editorRef.current?.view;
      for (const [clientId, state] of session.awareness.getStates()) {
        if (clientId === session.doc.clientID) continue;
        const user = state.user as AwarenessUser | undefined;
        const pointer = state.pointer as { pos: number; dx: number; dy: number } | null | undefined;
        if (!user?.peerId) continue;
        const coords = view && pointer ? view.coordsAtPos(Math.min(pointer.pos, view.state.doc.length)) : null;
        layer.placeAt(user.peerId, coords ? { x: coords.left + pointer!.dx + window.scrollX, y: coords.top + pointer!.dy + window.scrollY } : null);
      }
    };
    let frame = 0;
    const placeSoon = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const off = session.subscribe(sync);
    session.awareness.on("change", placeSoon);
    session.text.observe(placeSoon);
    window.addEventListener("resize", placeSoon);
    sync();
    return () => {
      off();
      session.awareness.off("change", placeSoon);
      session.text.unobserve(placeSoon);
      window.removeEventListener("resize", placeSoon);
      cancelAnimationFrame(frame);
      layer.destroy();
    };
  }, [session, editorRef]);
}

function Reading({ orgId, session, tree, onTag, openLink }: {
  orgId: string;
  session: DocSession;
  tree: DocTree;
  onTag: (tag: string) => void;
  openLink: (target: string | null, resolvedId: string | null, newTab: boolean) => Promise<void>;
}) {
  const [html, setHtml] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    const render = () => setHtml(renderMarkdown(session.text.toString(), {
      doc: (link) => {
        const doc = resolveLink(tree.docs, link);
        return doc ? { href: docPath(orgId, doc.id) } : null;
      },
    }));
    render();
    const update = () => {
      clearTimeout(timer);
      timer = window.setTimeout(render, 250);
    };
    session.text.observe(update);
    return () => {
      clearTimeout(timer);
      session.text.unobserve(update);
    };
  }, [session, tree, orgId]);

  // Comment embeds: fill in each one's card.
  useEffect(() => {
    for (const el of ref.current?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? []) {
      const id = el.dataset.commentId!;
      void loadComment(id).then((c) => {
        el.replaceChildren(commentCard(c, id));
      });
    }
  }, [html]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>("a");
    if (!a) return;
    if (a.dataset.tag) {
      e.preventDefault();
      onTag(a.dataset.tag);
    } else if (a.dataset.create !== undefined) {
      e.preventDefault();
      void openLink(a.dataset.create, null, false);
    } else if (a.classList.contains("doc-wikilink") || (a.getAttribute("href")?.startsWith("/") && !a.target)) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      navigate(a.getAttribute("href")!);
    }
  };

  // eslint-disable-next-line react/no-danger -- rendered by renderMarkdown, which escapes all raw HTML
  return <div ref={ref} className="doc-reading" onClick={onClick} dangerouslySetInnerHTML={{ __html: html || `<p class="text-muted-foreground">${escapeHtml("This doc is empty.")}</p>` }} />;
}

/** A linked page comment, as a card in reading view. Built with textContent. */
function commentCard(comment: CommentInfo | null, id: string): HTMLElement {
  const card = document.createElement("a");
  card.className = "doc-comment-card";
  card.href = `/comments/${id}`;
  if (!comment) {
    card.textContent = "A page comment you can't see (or that was deleted).";
    card.classList.add("missing");
    return card;
  }
  const head = document.createElement("span");
  head.className = "doc-comment-card-head";
  head.textContent = `💬 ${comment.author.displayName} · ${comment.projectName}${comment.status === "Resolved" ? " · resolved" : ""}`;
  const body = document.createElement("span");
  body.className = "doc-comment-card-body";
  body.textContent = comment.body;
  card.append(head, body);
  if (comment.pageUrl) {
    const page = document.createElement("span");
    page.className = "doc-comment-card-page";
    page.textContent = hostOf(comment.pageUrl) + new URL(comment.pageUrl).pathname;
    card.append(page);
  }
  return card;
}

/* ------------------------------------------------------------------ right panel */

function InfoPanel({ orgId, info, session, onTag }: { orgId: string; info: DocInfo; session: DocSession; onTag: (tag: string) => void }) {
  const [outline, setOutline] = useState(() => headings(session.text.toString()));
  useEffect(() => {
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => setOutline(headings(session.text.toString())), 400);
    };
    session.text.observe(update);
    update();
    return () => {
      clearTimeout(timer);
      session.text.unobserve(update);
    };
  }, [session]);

  return (
    <aside className="hidden border-l px-5 py-6 text-sm xl:sticky xl:top-14 xl:block xl:h-[calc(100svh-3.5rem)] xl:overflow-y-auto">
      <PanelSection icon={<Link2 className="size-4" />} title="Linked from" count={info.backlinks.length}>
        {info.backlinks.length === 0 ? <Muted>No other docs link here yet.</Muted> : info.backlinks.map((d) => (
          <Link key={d.id} to={docPath(orgId, d.id)} className="block truncate rounded-md px-2 py-1 hover:bg-muted" title={pathOf(d)}>{d.title}</Link>
        ))}
      </PanelSection>

      <PanelSection icon={<MessageSquare className="size-4" />} title="Page comments linking here" count={info.commentBacklinks.length}>
        {info.commentBacklinks.length === 0 ? <Muted>Write [[{info.title}]] in a page comment to link it here.</Muted> : info.commentBacklinks.map((c) => (
          <Link key={c.annotationId} to={`/comments/${c.annotationId}`} className="block rounded-lg border px-3 py-2 hover:bg-muted">
            <span className="block text-xs text-muted-foreground">{c.author.displayName} · {c.projectName}{c.status === "Resolved" ? " · resolved" : ""}</span>
            <span className="line-clamp-3">{c.body}</span>
            {c.pageUrl && <span className="mt-1 block truncate text-xs text-muted-foreground">{hostOf(c.pageUrl)}</span>}
          </Link>
        ))}
      </PanelSection>

      <PanelSection title="Links" count={info.links.length}>
        {info.links.length === 0 ? <Muted>Type [[ to link another doc.</Muted> : info.links.map((l) => (
          l.docId
            ? <Link key={l.text} to={docPath(orgId, l.docId)} className="block truncate rounded-md px-2 py-1 hover:bg-muted">{l.title}</Link>
            : <span key={l.text} className="block truncate px-2 py-1 text-muted-foreground" title="This doc doesn't exist yet">{l.text} <span className="text-xs">(missing)</span></span>
        ))}
      </PanelSection>

      {info.tags.length > 0 && (
        <PanelSection title="Tags" count={info.tags.length}>
          <div className="flex flex-wrap gap-1.5 px-2">
            {info.tags.map((t) => <button key={t} type="button" onClick={() => onTag(t)} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary hover:bg-primary/20">#{t}</button>)}
          </div>
        </PanelSection>
      )}

      {outline.length > 0 && (
        <PanelSection title="Outline" count={outline.length}>
          {outline.map((h, i) => (
            <button
              key={`${h.from}-${i}`}
              type="button"
              className="block w-full truncate rounded-md px-2 py-0.5 text-left text-muted-foreground hover:bg-muted hover:text-foreground"
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

function scrollToHeading(text: string) {
  const candidates = document.querySelectorAll<HTMLElement>(".doc-editor .cm-line, .doc-reading h1, .doc-reading h2, .doc-reading h3, .doc-reading h4, .doc-reading h5, .doc-reading h6");
  const target = [...candidates].find((el) => el.textContent?.replace(/^#+\s*/, "").trim() === text.trim());
  target?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function PanelSection({ icon, title, count, children }: { icon?: React.ReactNode; title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 flex items-center gap-1.5 px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {icon}{title}<span className="font-normal">{count}</span>
      </h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="px-2 text-muted-foreground">{children}</p>;
}

/* ------------------------------------------------------------------ history */

function HistoryDialog({ docId, session, canEdit, open, onOpenChange }: { docId: string; session: DocSession; canEdit: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const history = useAsync(() => (open ? docsApi.history(docId) : Promise.resolve([] as DocRevision[])), [docId, open]);
  const [shown, setShown] = useState<(DocRevision & { content: string }) | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => setShown(null), [open]);

  const show = async (r: DocRevision) => {
    try {
      setShown(await docsApi.revision(docId, r.id));
    } catch (e) {
      setError(e as Error);
    }
  };

  // Restoring is an ordinary edit, so everyone editing sees it and it can be undone.
  const restore = () => {
    if (!shown) return;
    session.doc.transact(() => {
      session.text.delete(0, session.text.length);
      session.text.insert(0, shown.content);
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>Saved versions of this doc. Edits are recorded at most every few minutes per person.</DialogDescription>
        </DialogHeader>
        <ErrorText error={error ?? history.error} />
        <div className="grid max-h-[60vh] gap-4 md:grid-cols-[220px_1fr]">
          <ul className="overflow-y-auto">
            {history.data?.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={cn("w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted", shown?.id === r.id && "bg-muted")}
                  onClick={() => void show(r)}
                >
                  <span className="block font-medium">{r.actor.displayName} {r.action}</span>
                  <span className="block text-xs text-muted-foreground" title={dateTime(r.occurredAt)}>{timeAgo(r.occurredAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="min-h-40 overflow-y-auto rounded-xl border bg-muted/30 p-3">
            {shown ? (
              <>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{shown.title}</span>
                  {canEdit && <Button size="sm" variant="outline" onClick={restore}>Restore this version</Button>}
                </div>
                <pre className="text-sm whitespace-pre-wrap">{shown.content || "(empty)"}</pre>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Pick a version to see it.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
