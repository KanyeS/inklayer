import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMe } from "@/App";
import { DocSession } from "@/docs/collab";
import { useSessionState } from "@/docs/doc-view/useSessionState";
import type { DocTree } from "@/docs/docsApi";
import { KanbanColumns } from "./KanbanColumns";
import { kanbanApi, kanbanQueries } from "./kanbanApi";
import { KanbanContext, type KanbanContextValue, useKanbanPeers, useKanbanState } from "./kanbanContext";
import { addTask, summaryMarkdown, type Task } from "./kanbanModel";
import { TaskPanel } from "./TaskPanel";

/**
 * A kanban inside a card on a canvas board: its columns, live, with cards to drag between them. A task opens in a panel at
 * the side of the page, where it can also be pinned to the board as a card of its own.
 */
export function KanbanOnBoard({
  orgId,
  kanbanId,
  tree,
  pinTask,
}: {
  orgId: string;
  kanbanId: string;
  tree: DocTree;
  pinTask?: (task: Task) => void;
}) {
  const { me } = useMe();
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const [session, setSession] = useState<DocSession | null>(null);
  useEffect(() => {
    const s = new DocSession(kanbanId);
    s.shareAwareness = me.features.liveCursors;
    s.markdown = () => summaryMarkdown(s.doc, new Map(treeRef.current.docs.map((d) => [d.id, d])));
    setSession(s);
    void s.open();
    return () => {
      void s.close();
    };
  }, [kanbanId, me.features.liveCursors]);
  if (!session) return null;
  return <Live orgId={orgId} kanbanId={kanbanId} tree={tree} session={session} pinTask={pinTask} meId={me.id} />;
}

function Live({
  orgId,
  kanbanId,
  tree,
  session,
  pinTask,
  meId,
}: {
  orgId: string;
  kanbanId: string;
  tree: DocTree;
  session: DocSession;
  pinTask?: (task: Task) => void;
  meId: string;
}) {
  const status = useSessionState(session);
  const state = useKanbanState(session.doc);
  const peers = useKanbanPeers(session);
  const people = useQuery(kanbanQueries.people(kanbanId));
  const peopleById = useMemo(() => new Map((people.data ?? []).map((p) => [p.id, p])), [people.data]);
  const [selected, setSelected] = useState<string | null>(null);
  const canEdit = status?.canEdit ?? false;

  const createTask = useCallback<KanbanContextValue["createTask"]>(
    async ({ title, column, parent, top, assignees }) => {
      const [key] = await kanbanApi.reserveKeys(kanbanId, 1);
      if (!key) throw new Error("The server didn't give the task a key. Try again.");
      return addTask(session.doc, { key, title, column, parent, top, assignees, createdBy: meId });
    },
    [kanbanId, session.doc, meId],
  );

  const context = useMemo<KanbanContextValue>(
    () => ({
      orgId,
      kanbanId,
      doc: session.doc,
      session,
      tree,
      canEdit,
      meId,
      people: peopleById,
      openTask: setSelected,
      createTask,
      pinTask,
    }),
    [orgId, kanbanId, session, tree, canEdit, meId, peopleById, createTask, pinTask],
  );

  const task = selected ? state.tasks.get(selected) : undefined;
  if (!status?.loaded) {
    return <p className="p-3 text-sm text-muted-foreground">{status?.error || "Connecting…"}</p>;
  }
  return (
    <KanbanContext.Provider value={context}>
      <div className="kanban-on-board nodrag nowheel nopan">
        <KanbanColumns state={state} visible={() => true} groupBy="none" selected={selected} peers={peers} compact />
      </div>
      {task &&
        createPortal(
          <div className="kanban-panel-floating">
            <TaskPanel key={task.id} task={task} state={state} onClose={() => setSelected(null)} />
          </div>,
          document.body,
        )}
    </KanbanContext.Provider>
  );
}
