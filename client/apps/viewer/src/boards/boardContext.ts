import { createContext, useContext } from "react";
import type * as Y from "yjs";
import type { DocTree } from "@/docs/docsApi";
import type { BoardDoc } from "./boardApi";

/** What every card on a board needs, without passing it through xyflow's node data. */
export interface BoardContextValue {
  orgId: string;
  boardId: string;
  doc: Y.Doc;
  canEdit: boolean;
  tree: DocTree;
  /** The docs on the board, as the server last described them; missing ones are deleted or can't be opened. */
  docs: Map<string, BoardDoc>;
  /** Whether the server has answered for the docs yet (so a missing one really is missing). */
  docsLoaded: boolean;
  /** Who else has each card selected: card id → their colours. */
  selectedBy: Map<string, string[]>;
  /** Opens a doc's own page. */
  openDoc: (docId: string, newTab?: boolean) => void;
  /** Tells the board a card's drawn height changed (columns restack). */
  measured: () => void;
}

export const BoardContext = createContext<BoardContextValue | null>(null);

export function useBoard(): BoardContextValue {
  const value = useContext(BoardContext);
  if (!value) throw new Error("useBoard outside a board");
  return value;
}
