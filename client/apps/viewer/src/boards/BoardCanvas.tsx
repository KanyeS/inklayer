import "@xyflow/react/dist/style.css";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  type Connection,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  type OnBeforeDelete,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnNodesChange,
  type OnSelectionChangeFunc,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useSelectionStore,
  ViewportPortal,
} from "@xyflow/react";
import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import type { AwarenessUser, DocSession } from "@/docs/collab";
import { type DocTree, docPath } from "@/docs/docsApi";
import { DRAG_DOC } from "@/docs/sidebar/folders";
import { queries } from "@/lib/queries";
import { navigate } from "@/lib/router";
import { BoardToolbar } from "./BoardToolbar";
import { boardQueries } from "./boardApi";
import { BoardContext, type BoardContextValue } from "./boardContext";
import {
  type Arrow,
  absolutePosition,
  addArrow,
  addCard,
  arrowsOf,
  type Card,
  cardsOf,
  LOCAL,
  layoutColumn,
  moveCards,
  raiseCard,
  readArrows,
  readCards,
  removeArrows,
  removeCards,
  setColumn,
} from "./boardModel";
import { type BoardNode, type CardNode, type CommentNode, nodeTypes } from "./cards";
import { type BoardEdge, edgeTypes } from "./edges";
import { pasteOrDrop } from "./media";

export interface BoardCanvasProps {
  orgId: string;
  boardId: string;
  session: DocSession;
  tree: DocTree;
  canEdit: boolean;
  liveCursors: boolean;
  /** Set to a function that centres the board on someone's pointer, for the header's faces. */
  followRef: React.RefObject<((peerId: string) => void) | null>;
}

export function BoardCanvas(props: BoardCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** Cards and arrows as stored, re-read whenever anyone changes them (typing in a note doesn't count). */
function useBoardContents(doc: Y.Doc) {
  const [cards, setCards] = useState<Card[]>(() => readCards(doc));
  const [arrows, setArrows] = useState<Arrow[]>(() => readArrows(doc));
  useEffect(() => {
    const onCards = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      if (events.every((e) => e.target instanceof Y.Text)) return;
      setCards(readCards(doc));
    };
    const onArrows = () => setArrows(readArrows(doc));
    cardsOf(doc).observeDeep(onCards);
    arrowsOf(doc).observeDeep(onArrows);
    setCards(readCards(doc));
    setArrows(readArrows(doc));
    return () => {
      cardsOf(doc).unobserveDeep(onCards);
      arrowsOf(doc).unobserveDeep(onArrows);
    };
  }, [doc]);
  return { cards, arrows };
}

type Box = { x: number; y: number; w: number; h: number };

/** Others' awareness on the board: their pointer, the box they're dragging to select, and what they have selected. */
function usePeersOnBoard(session: DocSession) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    // Only others' changes: this person's own pointer and selection needn't redraw the board.
    const bump = (_: unknown, origin: unknown) => origin !== "local" && setVersion((v) => v + 1);
    session.awareness.on("change", bump);
    return () => session.awareness.off("change", bump);
  }, [session]);
  return useMemo(() => {
    void version;
    const pointers: { peerId: string; name: string; color: string; x: number; y: number }[] = [];
    const marquees: { peerId: string; name: string; color: string; box: Box }[] = [];
    const selectedBy = new Map<string, { name: string; color: string }[]>();
    for (const [clientId, state] of session.awareness.getStates()) {
      if (clientId === session.doc.clientID) continue;
      const user = state.user as AwarenessUser | undefined;
      if (!user) continue;
      const pointer = state.board as { x: number; y: number } | null | undefined;
      if (pointer) pointers.push({ peerId: user.peerId, name: user.name, color: user.color, ...pointer });
      const marquee = state.marquee as Box | null | undefined;
      if (marquee) marquees.push({ peerId: user.peerId, name: user.name, color: user.color, box: marquee });
      for (const id of (state.selection as string[] | undefined) ?? []) {
        selectedBy.set(id, [...(selectedBy.get(id) ?? []), { name: user.name, color: user.color }]);
      }
    }
    return { pointers, marquees, selectedBy };
  }, [session, version]);
}

/** Cards whose height follows their content. The rest are as tall as stored. */
const FIXED_HEIGHT = new Set<Card["type"]>(["image", "column"]);

export function toNode(card: Card, cardIds: Set<string>, previous: BoardNode | undefined, canEdit: boolean): CardNode {
  const fixed = FIXED_HEIGHT.has(card.type) || (card.type === "doc" && !!card.expanded);
  const parentId = card.parent && cardIds.has(card.parent) ? card.parent : undefined;
  const keep = previous?.dragging || previous?.resizing; // this person is moving it: their copy wins until they let go
  return {
    id: card.id,
    type: card.type,
    position: keep && previous ? previous.position : { x: card.x, y: card.y },
    data: { card },
    parentId,
    width: keep && previous?.width ? previous.width : card.w,
    height: fixed ? (keep && previous?.height ? previous.height : card.h) : undefined,
    zIndex: card.type === "column" ? 0 : card.z + 1,
    selected: previous?.selected,
    dragging: previous?.dragging,
    measured: previous?.measured,
    draggable: canEdit,
    connectable: canEdit,
    dragHandle: card.type === "doc" && card.expanded ? ".board-drag" : undefined,
    style:
      card.type === "doc" && card.expanded ? undefined : { minHeight: FIXED_HEIGHT.has(card.type) ? undefined : 40 },
  };
}

const POINTER_EVERY_MS = 80;

function Canvas({ orgId, boardId, session, tree, canEdit, liveCursors, followRef }: BoardCanvasProps) {
  const doc = session.doc;
  const flow = useReactFlow<BoardNode, BoardEdge>();
  const wrapper = useRef<HTMLDivElement>(null);
  const { cards, arrows } = useBoardContents(doc);
  const { pointers, marquees, selectedBy } = usePeersOnBoard(session);
  const [showLinks, setShowLinks] = useState(true);
  const [showComments, setShowComments] = useState(true);

  const undo = useMemo(
    () => new Y.UndoManager([cardsOf(doc), arrowsOf(doc)], { trackedOrigins: new Set([LOCAL]) }),
    [doc],
  );
  useEffect(() => () => undo.destroy(), [undo]);

  // The docs on the board: their titles and previews, and the links between them.
  const docIds = useMemo(() => [...new Set(cards.flatMap((c) => (c.type === "doc" ? [c.docId] : [])))], [cards]);
  const docs = useQuery(boardQueries.cards(boardId, docIds));
  const docsById = useMemo(() => new Map((docs.data ?? []).map((d) => [d.id, d])), [docs.data]);
  const graph = useQuery({ ...queries.docGraph(orgId), refetchInterval: 15_000, enabled: showLinks || showComments });

  /* ------------------------------------------------------------------ nodes and edges */

  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const cardIds = useMemo(() => new Set(cards.map((c) => c.id)), [cards]);

  const comments = useMemo(() => {
    if (!showComments || !graph.data) return { nodes: [] as CommentNode[], edges: [] as BoardEdge[] };
    const cardOfDoc = new Map(cards.flatMap((c) => (c.type === "doc" ? [[c.docId, c] as const] : [])));
    const byId = new Map(cards.map((c) => [c.id, c]));
    const labels = new Map(graph.data.nodes.filter((n) => n.kind === "comment").map((n) => [n.id, n]));
    const stacked = new Map<string, number>();
    const nodes: CommentNode[] = [];
    const edges: BoardEdge[] = [];
    const placed = new Set<string>();
    for (const e of graph.data.edges) {
      const [docNode, commentNode] = e.source.startsWith("d:") ? [e.source, e.target] : [e.target, e.source];
      const card = cardOfDoc.get(docNode.slice(2));
      const comment = labels.get(commentNode);
      if (!card || !comment?.annotationId) continue;
      const id = `comment:${comment.annotationId}`;
      if (!placed.has(id)) {
        placed.add(id);
        const index = stacked.get(card.id) ?? 0;
        stacked.set(card.id, index + 1);
        const at = absolutePosition(card, byId);
        nodes.push({
          id,
          type: "comment",
          position: { x: at.x + card.w + 48, y: at.y + index * 40 },
          data: { annotationId: comment.annotationId, label: comment.label },
          draggable: false,
          selectable: false,
          deletable: false,
          connectable: false,
        });
      }
      edges.push({
        id: `c:${card.id}:${id}`,
        source: card.id,
        target: id,
        type: "link",
        deletable: false,
        selectable: false,
      });
    }
    return { nodes, edges };
  }, [showComments, graph.data, cards]);

  useEffect(() => {
    setNodes((previous) => {
      const byId = new Map(previous.map((n) => [n.id, n]));
      return [...cards.map((c) => toNode(c, cardIds, byId.get(c.id), canEdit)), ...comments.nodes];
    });
  }, [cards, cardIds, canEdit, comments.nodes]);

  const edges = useMemo<BoardEdge[]>(() => {
    const marker = { type: MarkerType.ArrowClosed, width: 18, height: 18 };
    const drawn: BoardEdge[] = arrows
      .filter((a) => cardIds.has(a.from) && cardIds.has(a.to))
      .map((a) => ({
        id: a.id,
        source: a.from,
        target: a.to,
        type: "arrow",
        data: { label: a.label, color: a.color },
        markerEnd: { ...marker, color: a.color ?? "var(--board-arrow)" },
        deletable: canEdit,
      }));
    const linked: BoardEdge[] = [];
    if (showLinks && graph.data) {
      const cardOfDoc = new Map<string, string>(
        cards.flatMap((c) => (c.type === "doc" ? [[`d:${c.docId}`, c.id]] : [])),
      );
      const seen = new Set<string>();
      for (const e of graph.data.edges) {
        const from = cardOfDoc.get(e.source);
        const to = cardOfDoc.get(e.target);
        const id = `link:${from}:${to}`;
        if (!from || !to || seen.has(id)) continue;
        seen.add(id);
        linked.push({
          id,
          source: from,
          target: to,
          type: "link",
          markerEnd: { ...marker, color: "var(--board-link)" },
          deletable: false,
          selectable: false,
        });
      }
    }
    return [...linked, ...drawn, ...comments.edges];
  }, [arrows, cards, cardIds, canEdit, showLinks, graph.data, comments.edges]);

  /* ------------------------------------------------------------------ changes from xyflow */

  /** Drawn heights, for stacking cards in columns. */
  const heights = useCallback(() => {
    const map = new Map<string, number>();
    for (const n of flow.getNodes()) if (n.measured?.height) map.set(n.id, n.measured.height);
    return map;
  }, [flow]);

  const restack = useRef(new Set<string>());
  const restackTimer = useRef(0);
  const restackSoon = useCallback(
    (columns: Iterable<string>) => {
      if (!canEdit) return;
      for (const c of columns) restack.current.add(c);
      clearTimeout(restackTimer.current);
      restackTimer.current = window.setTimeout(() => {
        const h = heights();
        for (const c of restack.current) layoutColumn(doc, c, h);
        restack.current.clear();
      }, 50);
    },
    [canEdit, doc, heights],
  );

  const onNodesChange: OnNodesChange<BoardNode> = useCallback(
    (changes) => {
      setNodes((ns) => changes.applyTo(ns));
      if (!canEdit) return;
      const moves = changes
        .getByType("position")
        .flatMap((c) => (c.position && cardIds.has(c.id) ? [{ id: c.id, ...c.position }] : []));
      moveCards(doc, moves);
      const removed = changes
        .getByType("remove")
        .map((c) => c.id)
        .filter((id) => cardIds.has(id));
      if (removed.length) removeCards(doc, removed);
      // A card in a column grew or shrank: restack the column.
      const parents = new Set<string>();
      for (const c of changes.getByType("dimensions")) {
        const parent = flow.getNode(c.id)?.parentId;
        if (parent && !c.resizing) parents.add(parent);
      }
      if (parents.size) restackSoon(parents);
    },
    [canEdit, cardIds, doc, flow, restackSoon],
  );

  const onEdgesChange: OnEdgesChange<BoardEdge> = useCallback(
    (changes) => {
      const removed = changes.getByType("remove").map((c) => c.id);
      if (canEdit && removed.length) removeArrows(doc, removed);
    },
    [canEdit, doc],
  );

  // Deleting a column keeps the cards in it (they stay on the board where they were).
  const onBeforeDelete: OnBeforeDelete<BoardNode, BoardEdge> = useCallback(async ({ nodes: gone, edges: lines }) => {
    const ids = new Set(gone.map((n) => n.id));
    const kept = gone.filter((n) => !(n.parentId && ids.has(n.parentId) && !n.selected));
    return { nodes: kept, edges: lines.filter((e) => e.type === "arrow") };
  }, []);

  const onConnect = useCallback((c: Connection) => canEdit && void addArrow(doc, c.source, c.target), [canEdit, doc]);

  const onNodeDragStart: OnNodeDrag<BoardNode> = useCallback(
    (_, node) => canEdit && node.type !== "column" && node.type !== "comment" && raiseCard(doc, node.id),
    [canEdit, doc],
  );

  // Dropped into a column, out of one, or moved within one.
  const onNodeDragStop: OnNodeDrag<BoardNode> = useCallback(
    (_, _node, dragged) => {
      if (!canEdit) return;
      const columns = flow.getNodes().filter((n) => n.type === "column" && !dragged.some((d) => d.id === n.id));
      const h = heights();
      for (const n of dragged) {
        if (n.type === "column" || n.type === "comment") continue;
        const internal = flow.getInternalNode(n.id);
        if (!internal) continue;
        const at = internal.internals.positionAbsolute;
        const cx = at.x + (internal.measured.width ?? 0) / 2;
        const cy = at.y + Math.min(40, (internal.measured.height ?? 0) / 2);
        const into = columns.find((c) => {
          const box = flow.getInternalNode(c.id);
          if (!box) return false;
          const p = box.internals.positionAbsolute;
          return (
            cx >= p.x && cx <= p.x + (box.measured.width ?? 0) && cy >= p.y && cy <= p.y + (box.measured.height ?? 0)
          );
        });
        if ((into?.id ?? undefined) !== n.parentId) setColumn(doc, n.id, into?.id ?? null, at, h);
        else if (n.parentId) layoutColumn(doc, n.parentId, h);
      }
    },
    [canEdit, doc, flow, heights],
  );

  const onSelectionChange: OnSelectionChangeFunc<BoardNode, BoardEdge> = useCallback(
    ({ nodes: selected }) => {
      if (liveCursors)
        session.awareness.setLocalStateField(
          "selection",
          selected.map((n) => n.id),
        );
    },
    [session, liveCursors],
  );

  /* ------------------------------------------------------------------ adding things */

  /** The middle of what's on screen, on the board, nudged so cards added one after another don't land on each other. */
  const nudge = useRef(0);
  const centreOfView = useCallback(() => {
    const box = wrapper.current?.getBoundingClientRect();
    const at = flow.screenToFlowPosition({
      x: (box?.left ?? 0) + (box?.width ?? 0) / 2,
      y: (box?.top ?? 0) + (box?.height ?? 0) / 2,
    });
    const step = (nudge.current++ % 6) * 24;
    return { x: at.x - 120 + step, y: at.y - 80 + step };
  }, [flow]);

  const addDoc = useCallback(
    (docId: string, at?: { x: number; y: number }, expanded = false) => {
      const existing = cards.find((c) => c.type === "doc" && c.docId === docId);
      if (existing) {
        const byId = new Map(cards.map((c) => [c.id, c]));
        const p = absolutePosition(existing, byId);
        void flow.setCenter(p.x + existing.w / 2, p.y + existing.h / 2, { duration: 300, zoom: flow.getZoom() });
        return;
      }
      const id = addCard(doc, at ?? centreOfView(), { type: "doc", docId });
      if (expanded) cardsOf(doc).get(id)?.set("expanded", true);
    },
    [cards, doc, flow, centreOfView],
  );

  const onDrop = (e: DragEvent) => {
    if (!canEdit) return;
    e.preventDefault();
    const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const docId = e.dataTransfer.getData(DRAG_DOC);
    if (docId) return addDoc(docId, at);
    void pasteOrDrop(doc, boardId, e.dataTransfer, at);
  };

  // Pasting a link or a picture adds a card for it in the middle of the view.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!canEdit || !e.clipboardData || isTyping(e.target)) return;
      if (!wrapper.current?.matches(":hover, :focus-within")) return;
      e.preventDefault();
      void pasteOrDrop(doc, boardId, e.clipboardData, centreOfView());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [canEdit, doc, boardId, centreOfView]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTyping(e.target) || !canEdit) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) undo.redo();
      else undo.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      undo.redo();
    }
  };

  // Double-clicking the empty board adds a note there.
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!canEdit || !(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
    addCard(doc, flow.screenToFlowPosition({ x: e.clientX - 20, y: e.clientY - 20 }), { type: "note" });
  };

  /* ------------------------------------------------------------------ presence */

  // The box this person is dragging to select, in board coordinates, so others see it where it is on their screen.
  const selecting = useSelectionStore((s) => s.userSelectionRect);
  const lastMarquee = useRef(0);
  useEffect(() => {
    if (!liveCursors) return;
    if (!selecting || selecting.width + selecting.height < 4) {
      session.awareness.setLocalStateField("marquee", null);
      return;
    }
    const now = performance.now();
    if (now - lastMarquee.current < POINTER_EVERY_MS) return;
    lastMarquee.current = now;
    const { x, y, zoom } = flow.getViewport();
    session.awareness.setLocalStateField("marquee", {
      x: Math.round((selecting.x - x) / zoom),
      y: Math.round((selecting.y - y) / zoom),
      w: Math.round(selecting.width / zoom),
      h: Math.round(selecting.height / zoom),
    } satisfies Box);
  }, [selecting, liveCursors, session, flow]);

  const lastPointer = useRef(0);
  const onMouseMove = (e: React.MouseEvent) => {
    if (!liveCursors) return;
    const now = performance.now();
    if (now - lastPointer.current < POINTER_EVERY_MS) return;
    lastPointer.current = now;
    const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    session.awareness.setLocalStateField("board", { x: Math.round(at.x), y: Math.round(at.y) });
  };
  const onMouseLeave = () => liveCursors && session.awareness.setLocalStateField("board", null);

  useEffect(() => {
    followRef.current = (peerId) => {
      const p = pointers.find((x) => x.peerId === peerId);
      if (p) void flow.setCenter(p.x, p.y, { duration: 400, zoom: flow.getZoom() });
    };
    return () => {
      followRef.current = null;
    };
  }, [followRef, pointers, flow]);

  /* ------------------------------------------------------------------ */

  // Stable, so cards that hold on to it (the live editor) aren't remade when the board redraws.
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const measured = useCallback(
    () => restackSoon(cardsRef.current.flatMap((c) => (c.parent ? [c.parent] : []))),
    [restackSoon],
  );

  const context = useMemo<BoardContextValue>(
    () => ({
      orgId,
      boardId,
      doc,
      canEdit,
      tree,
      docs: docsById,
      docsLoaded: docs.isFetched || docIds.length === 0,
      selectedBy,
      openDoc: (id, newTab) =>
        newTab ? window.open(docPath(orgId, id), "_blank", "noopener") : navigate(docPath(orgId, id)),
      measured,
    }),
    [orgId, boardId, doc, canEdit, tree, docsById, docs.isFetched, docIds.length, selectedBy, measured],
  );

  return (
    <BoardContext.Provider value={context}>
      <div
        ref={wrapper}
        className="board-canvas"
        onDragOver={(e) => canEdit && e.preventDefault()}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        onDoubleClick={onDoubleClick}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        <ReactFlow<BoardNode, BoardEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onBeforeDelete={onBeforeDelete}
          onConnect={onConnect}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          onSelectionChange={onSelectionChange}
          connectionMode={ConnectionMode.Loose}
          nodesDraggable={canEdit}
          nodesConnectable={canEdit}
          elementsSelectable
          deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
          zoomOnDoubleClick={false}
          selectionOnDrag
          panOnDrag={[1, 2]}
          panOnScroll
          minZoom={0.1}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={24} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable className="board-minimap" />
          <BoardToolbar
            orgId={orgId}
            tree={tree}
            boardId={boardId}
            canEdit={canEdit}
            onAddDoc={addDoc}
            onAdd={(card) => addCard(doc, centreOfView(), card)}
            showLinks={showLinks}
            setShowLinks={setShowLinks}
            showComments={showComments}
            setShowComments={setShowComments}
            undo={undo}
            folder={tree.docs.find((d) => d.id === boardId)?.folder ?? ""}
          />
          {liveCursors && (
            <ViewportPortal>
              {marquees.map((m) => (
                <div
                  key={m.peerId}
                  className="board-marquee"
                  style={{
                    transform: `translate(${m.box.x}px, ${m.box.y}px)`,
                    width: m.box.w,
                    height: m.box.h,
                    borderColor: m.color,
                    background: `color-mix(in srgb, ${m.color} 12%, transparent)`,
                  }}
                >
                  <span style={{ background: m.color }}>{m.name}</span>
                </div>
              ))}
              {pointers.map((p) => (
                <div
                  key={p.peerId}
                  className="board-pointer"
                  style={{ transform: `translate(${p.x}px, ${p.y}px)`, color: p.color }}
                >
                  <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
                    <path d="M1 1l5 14 2-6 6-2z" fill="currentColor" stroke="white" strokeWidth="1" />
                  </svg>
                  <span style={{ background: p.color }}>{p.name}</span>
                </div>
              ))}
            </ViewportPortal>
          )}
        </ReactFlow>
      </div>
    </BoardContext.Provider>
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}
