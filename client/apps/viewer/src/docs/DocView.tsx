import type { DocEditor } from "@inklayer/docs/editor";
import { applyFormat } from "@inklayer/docs/formatting";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useMe } from "@/App";
import { ErrorText, Loading } from "@/components/Layout";
import { queries } from "@/lib/queries";
import { DocSession } from "./collab";
import { DocBody } from "./doc-view/DocBody";
import { DocHeader, type Mode } from "./doc-view/DocHeader";
import { DocInfoPanel } from "./doc-view/DocInfoPanel";
import { HistoryDialog } from "./doc-view/HistoryDialog";
import { scrollToPointer } from "./doc-view/usePresence";
import { useSessionState } from "./doc-view/useSessionState";
import type { DocTree } from "./docsApi";
import { MarkdownGuide } from "./MarkdownGuide";

export { loadComment } from "./doc-view/comments";

/** Links, backlinks and tags are worked out by the server from saved text: refresh them this often. */
const INFO_REFRESH_MS = 15_000;

export interface DocViewProps {
  orgId: string;
  docId: string;
  tree: DocTree;
  onTag: (tag: string) => void;
}

/** One live session per doc view: opened on mount, saved and left on unmount. */
function useDocSession(docId: string, shareAwareness: boolean): DocSession | null {
  const [session, setSession] = useState<DocSession | null>(null);
  useEffect(() => {
    const s = new DocSession(docId);
    s.shareAwareness = shareAwareness;
    setSession(s);
    void s.open();
    return () => {
      void s.close();
    };
  }, [docId, shareAwareness]);
  return session;
}

/**
 * A doc: its header (title, status, tools), its text (live editor or reading view), the panel of links beside it,
 * and the history and cheat-sheet dialogs. The pieces live in doc-view/.
 */
export function DocView({ orgId, docId, tree, onTag }: DocViewProps) {
  const info = useQuery({ ...queries.doc(docId), refetchInterval: INFO_REFRESH_MS });
  const [mode, setMode] = useState<Mode>(tree.canEdit ? "edit" : "read");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // The editor (while editing), shared by the formatting toolbar and the cheat sheet's Insert buttons.
  const editorRef = useRef<DocEditor | null>(null);

  const { me } = useMe();
  const liveCursors = me.features.liveCursors;
  const session = useDocSession(docId, liveCursors);

  const snapshot = useSessionState(session);
  const canEdit = snapshot?.canEdit ?? false;
  useEffect(() => {
    if (snapshot && !snapshot.canEdit && mode === "edit" && snapshot.loaded) setMode("read");
  }, [snapshot, mode]);

  if (info.error) {
    return (
      <div className="p-6">
        <ErrorText error={info.error} />
      </div>
    );
  }
  if (!info.data || !session) {
    return (
      <div className="p-6">
        <Loading />
      </div>
    );
  }

  // Close the cheat sheet first, so focus goes back to the editor, then apply to the selection it kept.
  const insertFromGuide =
    mode === "edit" && canEdit
      ? (format: Parameters<typeof applyFormat>[1]) => {
          setGuideOpen(false);
          window.setTimeout(() => {
            const view = editorRef.current?.view;
            if (view) applyFormat(view, format);
          }, 0);
        }
      : undefined;

  return (
    <>
      <main className="min-w-0 px-6 pt-6 pb-10 md:px-10 lg:px-16">
        <div className="mx-auto max-w-3xl">
          <DocHeader
            orgId={orgId}
            info={info.data}
            tree={tree}
            session={session}
            mode={mode}
            setMode={setMode}
            canEdit={canEdit}
            onHistory={() => setHistoryOpen(true)}
            onGuide={() => setGuideOpen(true)}
            onTag={onTag}
            onFollow={liveCursors ? (peerId) => scrollToPointer(session, editorRef.current?.view, peerId) : undefined}
          />
          {snapshot?.loaded ? (
            <DocBody
              orgId={orgId}
              session={session}
              tree={tree}
              mode={mode}
              canEdit={canEdit}
              commentLinks={info.data.commentLinks}
              onTag={onTag}
              liveCursors={liveCursors}
              people={info.data.people ?? []}
              editorRef={editorRef}
              onGuide={() => setGuideOpen(true)}
            />
          ) : snapshot?.status === "offline" ? (
            <ErrorText error={new Error(snapshot.error || "Can't reach the server. Retrying…")} />
          ) : (
            <Loading />
          )}
        </div>
      </main>
      <DocInfoPanel orgId={orgId} info={info.data} session={session} />
      <HistoryDialog
        docId={docId}
        session={session}
        canEdit={canEdit}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
      <MarkdownGuide open={guideOpen} onOpenChange={setGuideOpen} onInsert={insertFromGuide} />
    </>
  );
}
