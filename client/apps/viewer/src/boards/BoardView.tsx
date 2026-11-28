import { Badge } from "@inklayer/ui/components/badge";
import { useQuery } from "@tanstack/react-query";
import { Building2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMe } from "@/App";
import { ConfirmButton } from "@/components/ConfirmButton";
import { ErrorText, Loading } from "@/components/Layout";
import { DocSession } from "@/docs/collab";
import { PeopleHere, SaveStatus, TitleRow } from "@/docs/doc-view/DocHeader";
import { OrgShareButton } from "@/docs/doc-view/OrgShareDialog";
import { useSessionState } from "@/docs/doc-view/useSessionState";
import { type DocTree, docsApi } from "@/docs/docsApi";
import { queries } from "@/lib/queries";
import { navigate } from "@/lib/router";
import { BoardCanvas } from "./BoardCanvas";
import { summaryMarkdown } from "./boardModel";

/** Links and backlinks are worked out by the server from saved summaries: refresh the details this often. */
const INFO_REFRESH_MS = 15_000;

/**
 * A board: a canvas of doc cards, notes, pictures, links and columns, co-edited live like a doc (the same hub, the same
 * access and sharing). Its summary, saved with each snapshot, links the docs on it, so they list the board in their
 * backlinks.
 */
export function BoardView({ orgId, docId, tree }: { orgId: string; docId: string; tree: DocTree }) {
  const info = useQuery({ ...queries.doc(docId), refetchInterval: INFO_REFRESH_MS });
  const { me } = useMe();
  const liveCursors = me.features.liveCursors;
  const treeRef = useRef(tree);
  treeRef.current = tree;

  const [session, setSession] = useState<DocSession | null>(null);
  useEffect(() => {
    const s = new DocSession(docId);
    s.shareAwareness = liveCursors;
    // Links in the summary are written as this organisation's docs are named now, so they follow renames.
    s.markdown = () => summaryMarkdown(s.doc, new Map(treeRef.current.docs.map((d) => [d.id, d])));
    setSession(s);
    void s.open();
    return () => {
      void s.close();
    };
  }, [docId, liveCursors]);

  const state = useSessionState(session);
  const canEdit = state?.canEdit ?? false;
  const [error, setError] = useState<Error | null>(null);
  const follow = useRef<((peerId: string) => void) | null>(null);

  if (info.error)
    return (
      <div className="p-6 xl:col-span-2">
        <ErrorText error={info.error} />
      </div>
    );
  if (!info.data || !session)
    return (
      <div className="p-6 xl:col-span-2">
        <Loading />
      </div>
    );

  const remove = async () => {
    try {
      await docsApi.delete(info.data.id, info.data.version);
      navigate(`/orgs/${orgId}/docs`);
    } catch (e) {
      setError(e as Error);
    }
  };

  return (
    <main className="board-page">
      <header className="board-header">
        <div className="min-w-0 flex-1 [&_.doc-title-input]:text-xl [&>div]:mt-0">
          <TitleRow info={info.data} canEdit={canEdit && !!info.data.canManage} onError={setError} />
        </div>
        {info.data.sharedFrom && (
          <Badge
            variant="outline"
            title={`This board belongs to ${info.data.sharedFrom.name}, which shares it with this organisation.`}
          >
            <Building2 data-icon="inline-start" />
            Shared from {info.data.sharedFrom.name}
          </Badge>
        )}
        <SaveStatus status={state?.status ?? "connecting"} canEdit={canEdit} />
        <PeopleHere
          peers={state?.peers ?? []}
          onFollow={liveCursors ? (peerId) => follow.current?.(peerId) : undefined}
        />
        <OrgShareButton info={info.data} />
        {info.data.canManage && (
          <ConfirmButton
            title={`Delete "${info.data.title}"?`}
            description="Anyone with it open loses it. The docs on it stay where they are. You can restore the board from Deleted docs at the bottom of the sidebar."
            confirmLabel="Delete board"
            onConfirm={() => void remove()}
          >
            <Trash2 />
          </ConfirmButton>
        )}
      </header>
      <ErrorText error={error} />
      {state?.loaded ? (
        <BoardCanvas
          orgId={orgId}
          boardId={docId}
          session={session}
          tree={tree}
          canEdit={canEdit}
          liveCursors={liveCursors}
          followRef={follow}
        />
      ) : state?.status === "offline" || state?.status === "closed" ? (
        <div className="p-6">
          <ErrorText error={new Error(state.error || "Can't reach the server. Retrying…")} />
        </div>
      ) : (
        <div className="p-6">
          <Loading />
        </div>
      )}
    </main>
  );
}
