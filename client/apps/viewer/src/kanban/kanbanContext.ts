import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import type { DocSession } from "@/docs/collab";
import type { DocTree } from "@/docs/docsApi";
import type { KanbanPerson } from "./kanbanApi";
import { type Column, type Relation, readColumns, readRelations, readTasks, type Task } from "./kanbanModel";

/** What a kanban's parts share: the live document, who can edit, the people tasks can be given to. */
export interface KanbanContextValue {
  orgId: string;
  kanbanId: string;
  doc: Y.Doc;
  /** The live session, when this is the kanban itself (not a saved version shown in history). */
  session: DocSession | null;
  tree: DocTree;
  canEdit: boolean;
  meId: string;
  people: Map<string, KanbanPerson>;
  openTask: (taskId: string | null) => void;
  /** On a canvas board: puts the task on the board as a card of its own. */
  pinTask?: (task: Task) => void;
  /** Adds a task with a key from the server; resolves to its id. */
  createTask: (fields: {
    title: string;
    column: string;
    parent?: string;
    top?: boolean;
    assignees?: string[];
  }) => Promise<string>;
}

export const KanbanContext = createContext<KanbanContextValue | null>(null);

export function useKanbanContext(): KanbanContextValue {
  const value = useContext(KanbanContext);
  if (!value) throw new Error("Not inside a kanban.");
  return value;
}

export interface KanbanState {
  columns: Column[];
  tasks: Map<string, Task>;
  relations: Relation[];
}

function read(doc: Y.Doc): KanbanState {
  const tasks = readTasks(doc);
  return { columns: readColumns(doc), tasks, relations: readRelations(doc, tasks) };
}

/** The kanban as plain data, read again (at most once a frame) whenever anyone changes it. */
export function useKanbanState(doc: Y.Doc): KanbanState {
  const [state, setState] = useState(() => read(doc));
  useEffect(() => {
    let frame = 0;
    const onUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setState(read(doc)));
    };
    setState(read(doc));
    doc.on("update", onUpdate);
    return () => {
      cancelAnimationFrame(frame);
      doc.off("update", onUpdate);
    };
  }, [doc]);
  return state;
}

export interface KanbanPeer {
  clientId: number;
  name: string;
  color: string;
  /** The task they have open, or are dragging. */
  task: string | null;
  dragging: boolean;
}

/** Others on the kanban and the task each has open or is dragging, from awareness. */
export function useKanbanPeers(session: DocSession | null): KanbanPeer[] {
  const [peers, setPeers] = useState<KanbanPeer[]>([]);
  useEffect(() => {
    if (!session) return;
    const awareness = session.awareness;
    const update = () => {
      const list: KanbanPeer[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === awareness.clientID) continue;
        const user = state.user as { name?: string; color?: string } | undefined;
        const kanban = state.kanban as { task?: string | null; dragging?: boolean } | undefined;
        if (!user?.name) continue;
        list.push({
          clientId,
          name: user.name,
          color: user.color ?? "#888888",
          task: kanban?.task ?? null,
          dragging: !!kanban?.dragging,
        });
      }
      setPeers(list);
    };
    update();
    awareness.on("change", update);
    return () => awareness.off("change", update);
  }, [session]);
  return peers;
}

/** Peers by the task they're on. */
export function usePeersByTask(peers: KanbanPeer[]): Map<string, KanbanPeer[]> {
  return useMemo(() => {
    const map = new Map<string, KanbanPeer[]>();
    for (const p of peers) if (p.task) map.set(p.task, [...(map.get(p.task) ?? []), p]);
    return map;
  }, [peers]);
}
