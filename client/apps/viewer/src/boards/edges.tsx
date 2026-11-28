import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getStraightPath,
  type InternalNode,
  useInternalNode,
} from "@xyflow/react";
import { useEffect, useState } from "react";
import { useBoard } from "./boardContext";
import { updateArrow } from "./boardModel";

/** An arrow someone drew (stored on the board), or one drawn for a [[link]] or a linked comment (not stored). */
export type ArrowEdge = Edge<{ label?: string; color?: string }, "arrow">;
export type LinkEdge = Edge<Record<string, never>, "link">;
export type BoardEdge = ArrowEdge | LinkEdge;

/** Where the line from one node's centre to another's leaves the first node's box. */
function edgePoint(node: InternalNode, toward: { x: number; y: number }): { x: number; y: number } {
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const cx = node.internals.positionAbsolute.x + w / 2;
  const cy = node.internals.positionAbsolute.y + h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  // Scale the direction so it just reaches the nearer side of the box.
  const scale = 1 / Math.max(Math.abs(dx) / (w / 2 || 1), Math.abs(dy) / (h / 2 || 1));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function centre(node: InternalNode) {
  return {
    x: node.internals.positionAbsolute.x + (node.measured.width ?? 0) / 2,
    y: node.internals.positionAbsolute.y + (node.measured.height ?? 0) / 2,
  };
}

/** The straight line between two cards, from edge to edge, whichever sides face each other. */
function useFloatingPath(source: string, target: string) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to) return null;
  const start = edgePoint(from, centre(to));
  const end = edgePoint(to, centre(from));
  const [path, labelX, labelY] = getStraightPath({
    sourceX: start.x,
    sourceY: start.y,
    targetX: end.x,
    targetY: end.y,
  });
  return { path, labelX, labelY };
}

export function ArrowEdgeView({ id, source, target, data, selected, markerEnd }: EdgeProps<ArrowEdge>) {
  const geometry = useFloatingPath(source, target);
  const { doc, canEdit } = useBoard();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(data?.label ?? "");
  useEffect(() => setLabel(data?.label ?? ""), [data?.label]);
  if (!geometry) return null;
  const save = () => {
    setEditing(false);
    if (label.trim() !== (data?.label ?? "")) updateArrow(doc, id, { label: label.trim() || null });
  };
  return (
    <>
      <BaseEdge
        id={id}
        path={geometry.path}
        markerEnd={markerEnd}
        interactionWidth={16}
        style={{ stroke: data?.color ?? "var(--board-arrow)", strokeWidth: selected ? 2.5 : 1.75 }}
      />
      {(editing || data?.label || (selected && canEdit)) && (
        <EdgeLabelRenderer>
          <div
            className="board-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${geometry.labelX}px, ${geometry.labelY}px)` }}
            onDoubleClick={() => canEdit && setEditing(true)}
          >
            {editing ? (
              <input
                // biome-ignore lint/a11y/noAutofocus: opened by double-clicking the label, to type it
                autoFocus
                className="w-32 bg-transparent text-center outline-none"
                value={label}
                maxLength={200}
                aria-label="Arrow label"
                onChange={(e) => setLabel(e.target.value)}
                onBlur={save}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") {
                    setLabel(data?.label ?? "");
                    setEditing(false);
                  }
                }}
              />
            ) : (
              data?.label || <span className="text-muted-foreground">Double-click to label</span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** A [[link]] between two docs on the board, or a doc's link to a comment: dashed, and follows the docs' text. */
export function LinkEdgeView({ id, source, target, markerEnd }: EdgeProps<LinkEdge>) {
  const geometry = useFloatingPath(source, target);
  if (!geometry) return null;
  return (
    <BaseEdge
      id={id}
      path={geometry.path}
      markerEnd={markerEnd}
      style={{ stroke: "var(--board-link)", strokeWidth: 1.5, strokeDasharray: "6 5" }}
    />
  );
}

export const edgeTypes = { arrow: ArrowEdgeView, link: LinkEdgeView };
