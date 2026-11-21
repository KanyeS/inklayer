import type { AccessMapEdge, AccessMapNode, AccessMapResponse } from "@inklayer/api";

/** Node size and spacing, in pixels. */
export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 56;
const GAP_X = 96;
const GAP_Y = 12;

export interface PlacedNode extends AccessMapNode {
  x: number;
  y: number;
}

export interface PlacedEdge extends AccessMapEdge {
  /** From the right edge of the source to the left edge of the target, as an SVG cubic curve. */
  path: string;
  /** Where to write the edge's role. */
  labelX: number;
  labelY: number;
}

export interface AccessMapLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

/**
 * Lays an access map out as a left-to-right flow chart: one column per `column` value (who → how → what), nodes stacked
 * in each column and the columns centred on each other. Within a column, nodes a preview changes come first so they're
 * seen without scrolling; otherwise the server's order (by name) is kept. Edges whose ends aren't in the map are dropped.
 */
export function layoutAccessMap(map: Pick<AccessMapResponse, "nodes" | "edges">): AccessMapLayout {
  const columns = [...new Set(map.nodes.map((n) => n.column))].sort((a, b) => a - b);
  const byColumn = columns.map((c) =>
    map.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.column === c)
      .sort((a, b) => Number(b.n.change != null) - Number(a.n.change != null) || a.i - b.i)
      .map(({ n }) => n),
  );
  const columnHeight = (count: number) => (count === 0 ? 0 : count * NODE_HEIGHT + (count - 1) * GAP_Y);
  const height = Math.max(0, ...byColumn.map((c) => columnHeight(c.length)));
  const width = columns.length === 0 ? 0 : columns.length * NODE_WIDTH + (columns.length - 1) * GAP_X;

  const nodes: PlacedNode[] = byColumn.flatMap((column, ci) => {
    const top = (height - columnHeight(column.length)) / 2;
    return column.map((n, ri) => ({ ...n, x: ci * (NODE_WIDTH + GAP_X), y: top + ri * (NODE_HEIGHT + GAP_Y) }));
  });

  const at = new Map(nodes.map((n) => [n.id, n]));
  const edges: PlacedEdge[] = map.edges.flatMap((e) => {
    const from = at.get(e.from);
    const to = at.get(e.to);
    if (!from || !to) return [];
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_HEIGHT / 2;
    const bend = (x2 - x1) / 2;
    return [
      {
        ...e,
        path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        // Near the target, so the roles of several routes into one product don't overlap at the source.
        labelX: x1 + (x2 - x1) * 0.7,
        labelY: y1 + (y2 - y1) * 0.78,
      },
    ];
  });

  return { nodes, edges, width, height };
}
