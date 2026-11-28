import { Button } from "@inklayer/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@inklayer/ui/components/dialog";
import { useQuery } from "@tanstack/react-query";
import { MarkerType, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { ErrorText } from "@/components/Layout";
import { fromBase64 } from "@/docs/collab";
import { RevisionButton } from "@/docs/doc-view/HistoryDialog";
import { type DocRevision, type DocTree, docPath, docsApi } from "@/docs/docsApi";
import { queries } from "@/lib/queries";
import { navigate } from "@/lib/router";
import { toNode } from "./BoardCanvas";
import { boardQueries } from "./boardApi";
import { BoardContext, type BoardContextValue } from "./boardContext";
import { readArrows, readCards, replaceBoard } from "./boardModel";
import { type BoardNode, nodeTypes } from "./cards";
import { type BoardEdge, edgeTypes } from "./edges";

interface Shown {
  revision: DocRevision;
  /** The board as it was; null for versions saved before boards kept their cards in history. */
  board: Y.Doc | null;
  summary: string;
}

export interface BoardHistoryProps {
  orgId: string;
  boardId: string;
  tree: DocTree;
  /** The live board, to restore into. */
  doc: Y.Doc;
  canEdit: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Saved versions of the board: pick one to see its cards as they were, and restore it if you can edit. */
export function BoardHistory({ orgId, boardId, tree, doc, canEdit, open, onOpenChange }: BoardHistoryProps) {
  // Fetched each time the dialog opens: the board keeps changing.
  const history = useQuery({ ...queries.docHistory(boardId), enabled: open, staleTime: 0 });
  const [shown, setShown] = useState<Shown | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Forget the shown version when the dialog closes (and free its copy of the board).
  useEffect(() => {
    if (!open) setShown(null);
  }, [open]);
  useEffect(() => () => shown?.board?.destroy(), [shown]);

  const show = async (revision: DocRevision) => {
    try {
      const full = await docsApi.revision(boardId, revision.id);
      let board: Y.Doc | null = null;
      if (full.state) {
        board = new Y.Doc();
        Y.applyUpdate(board, fromBase64(full.state));
      }
      setShown({ revision, board, summary: full.content });
      setError(null);
    } catch (e) {
      setError(e as Error);
    }
  };

  const restore = () => {
    if (!shown?.board) return;
    replaceBoard(doc, shown.board);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>History</DialogTitle>
          <DialogDescription>
            Saved versions of this board, at most every few minutes per person. Restoring puts the cards and arrows back
            as they were, for everyone; Ctrl Z undoes it.
          </DialogDescription>
        </DialogHeader>
        <ErrorText error={error ?? history.error} />
        <div className="grid h-[60vh] gap-4 md:grid-cols-[220px_1fr]">
          <ul className="overflow-y-auto">
            {history.data?.map((r) => (
              <li key={r.id}>
                <RevisionButton revision={r} selected={shown?.revision.id === r.id} onClick={() => void show(r)} />
              </li>
            ))}
          </ul>
          <div className="flex min-h-40 flex-col overflow-hidden rounded-xl border bg-muted/30">
            {shown ? (
              <>
                <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                  <span className="text-sm font-medium">{shown.revision.title}</span>
                  {canEdit && shown.board && (
                    <Button size="sm" variant="outline" onClick={restore}>
                      Restore this version
                    </Button>
                  )}
                </div>
                {shown.board ? (
                  <BoardPreview
                    key={shown.revision.id}
                    orgId={orgId}
                    boardId={boardId}
                    tree={tree}
                    board={shown.board}
                  />
                ) : (
                  <div className="overflow-y-auto p-3 text-sm">
                    <p className="mb-2 text-muted-foreground">
                      This version was saved before boards kept their cards in history. What was on it:
                    </p>
                    <pre className="whitespace-pre-wrap">{shown.summary || "(empty)"}</pre>
                  </div>
                )}
              </>
            ) : (
              <p className="p-3 text-sm text-muted-foreground">Pick a version to see it.</p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A saved version of the board, drawn as it was: look around, but nothing can be changed. */
function BoardPreview({
  orgId,
  boardId,
  tree,
  board,
}: {
  orgId: string;
  boardId: string;
  tree: DocTree;
  board: Y.Doc;
}) {
  const cards = useMemo(() => readCards(board), [board]);
  const arrows = useMemo(() => readArrows(board), [board]);
  const docIds = useMemo(() => [...new Set(cards.flatMap((c) => (c.type === "doc" ? [c.docId] : [])))], [cards]);
  const docs = useQuery(boardQueries.cards(boardId, docIds));

  const nodes = useMemo<BoardNode[]>(() => {
    const ids = new Set(cards.map((c) => c.id));
    // Doc cards show previews here, never the live editor: the editor would be today's text, not this version's.
    return cards.map((c) => toNode(c.type === "doc" ? { ...c, expanded: false } : c, ids, undefined, false));
  }, [cards]);
  const edges = useMemo<BoardEdge[]>(
    () =>
      arrows.map((a) => ({
        id: a.id,
        source: a.from,
        target: a.to,
        type: "arrow",
        data: { label: a.label, color: a.color },
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: a.color ?? "var(--board-arrow)" },
      })),
    [arrows],
  );

  const context = useMemo<BoardContextValue>(
    () => ({
      orgId,
      boardId,
      doc: board,
      canEdit: false,
      tree,
      docs: new Map((docs.data ?? []).map((d) => [d.id, d])),
      docsLoaded: docs.isFetched || docIds.length === 0,
      selectedBy: new Map(),
      openDoc: (id) => navigate(docPath(orgId, id)),
      measured: () => undefined,
    }),
    [orgId, boardId, board, tree, docs.data, docs.isFetched, docIds.length],
  );

  return (
    <BoardContext.Provider value={context}>
      <div className="board-preview relative min-h-0 flex-1">
        <ReactFlowProvider>
          <ReactFlow<BoardNode, BoardEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnScroll
            minZoom={0.1}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
          />
        </ReactFlowProvider>
      </div>
    </BoardContext.Provider>
  );
}
