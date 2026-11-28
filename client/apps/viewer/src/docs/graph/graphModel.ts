import type { SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import { DEFAULT_ICONS } from "../docIcons";
import type { DocGraph, DocTree } from "../docsApi";
import { docPath } from "../paths";

/**
 * The docs graph's data and geometry, without drawing: which nodes and links to show, how big each node is, which
 * labels show, which node is under the pointer, and zooming. Pure, and unit-tested in test/graphModel.test.ts.
 */

export interface Node extends SimulationNodeDatum {
  id: string;
  kind: "doc" | "comment" | "tag";
  label: string;
  href: string | null;
  degree: number;
  /** The Lucide icon drawn in the node: the doc's own, or the default for its kind. */
  icon: string;
  /** The doc's own colour; null for the default for its kind. */
  color: string | null;
}

export type Edge = SimulationLinkDatum<Node>;

/** Pan and zoom: world point (0,0) is drawn at screen (x,y), scaled by k. */
export interface View {
  x: number;
  y: number;
  k: number;
}

export interface GraphOptions {
  showComments: boolean;
  showTags: boolean;
  /** Only docs with any of these tags (and comments linked to them); empty for every doc. */
  onlyTags: ReadonlySet<string>;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;
/** Labels show for every node once zoomed in this far. */
export const LABELS_FROM_ZOOM = 0.9;
const MAX_LABEL_CHARS = 40;
/** How far outside a node (in screen pixels) the pointer can be and still hit it. */
const HIT_SLOP_PX = 6;
const WHEEL_ZOOM_SPEED = 0.0015;

/** The nodes and links to show, from the server's graph and the docs' tags. */
export function buildGraph(
  orgId: string,
  graph: DocGraph,
  tree: Pick<DocTree, "docs" | "tags">,
  { showComments, showTags, onlyTags }: GraphOptions,
): { nodes: Node[]; edges: Edge[] } {
  // With tags chosen: their docs, and comments linked to those docs.
  const tagsOf = new Map(tree.docs.map((d) => [`d:${d.id}`, d.tags]));
  const keptDocs = new Set(
    graph.nodes
      .filter((n) => n.kind === "doc" && (onlyTags.size === 0 || tagsOf.get(n.id)?.some((t) => onlyTags.has(t))))
      .map((n) => n.id),
  );
  const nearKept = new Set(
    graph.edges.flatMap((e) => {
      if (keptDocs.has(e.source)) return [e.target];
      if (keptDocs.has(e.target)) return [e.source];
      return [];
    }),
  );
  const nodes: Node[] = graph.nodes
    .filter((n) =>
      n.kind === "doc" ? keptDocs.has(n.id) : showComments && (onlyTags.size === 0 || nearKept.has(n.id)),
    )
    .map((n) => ({
      id: n.id,
      kind: n.kind,
      label: n.label,
      degree: 0,
      href: n.kind === "doc" ? docPath(orgId, n.docId ?? "") : `/comments/${n.annotationId}`,
      icon: n.icon ?? (n.board ? DEFAULT_ICONS.board : DEFAULT_ICONS[n.kind]),
      color: n.color ?? null,
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = graph.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));
  if (showTags) addTags(tree, ids, onlyTags, nodes, edges);
  countDegrees(nodes, edges);
  return { nodes, edges };
}

/** Each tag once, in its own icon and colour (with tags chosen, only those), linked to its docs. */
function addTags(
  tree: Pick<DocTree, "docs" | "tags">,
  ids: Set<string>,
  onlyTags: ReadonlySet<string>,
  nodes: Node[],
  edges: Edge[],
): void {
  const shown = tree.docs.filter((d) => ids.has(`d:${d.id}`));
  const tags = new Set(shown.flatMap((d) => d.tags).filter((t) => onlyTags.size === 0 || onlyTags.has(t)));
  for (const tag of tags) {
    const style = tree.tags?.find((t) => t.tag === tag);
    nodes.push({
      id: `t:${tag}`,
      kind: "tag",
      label: `#${tag}`,
      href: null,
      degree: 0,
      icon: style?.icon ?? DEFAULT_ICONS.tag,
      color: style?.color ?? null,
    });
  }
  for (const d of shown) {
    for (const tag of d.tags) if (tags.has(tag)) edges.push({ source: `d:${d.id}`, target: `t:${tag}` });
  }
}

function idOf(end: Edge["source"]): string {
  return typeof end === "object" ? end.id : String(end);
}

function countDegrees(nodes: Node[], edges: Edge[]): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const s = byId.get(idOf(e.source));
    const t = byId.get(idOf(e.target));
    if (s) s.degree++;
    if (t) t.degree++;
  }
}

/** Each node's id with the ids of the nodes it's linked to (and itself). */
export function neighboursOf(nodes: Node[], edges: Edge[]): Map<string, Set<string>> {
  const neighbours = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set([n.id])]));
  for (const e of edges) {
    const s = idOf(e.source);
    const t = idOf(e.target);
    neighbours.get(s)?.add(t);
    neighbours.get(t)?.add(s);
  }
  return neighbours;
}

/** A node's radius: docs grow with how linked they are. */
export function radius(n: Pick<Node, "kind" | "degree">): number {
  if (n.kind === "doc") return 10 + Math.sqrt(n.degree) * 2.4;
  return n.kind === "tag" ? 9 : 8;
}

/** A label short enough to draw. */
export function shortLabel(label: string): string {
  return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS)}…` : label;
}

/** Whether a node matches the highlight text (already trimmed and lower-cased); everything matches "". */
export function matches(n: Pick<Node, "label">, query: string): boolean {
  return !query || n.label.toLowerCase().includes(query);
}

/**
 * Whether a node's label is drawn: the hovered node's always; with something hovered, its neighbours'; otherwise all
 * once zoomed in, or those matching the highlight. Comments never show labels (they're long).
 */
export function labelVisible(
  n: Pick<Node, "id" | "kind" | "label">,
  state: { hovered: boolean; focus: Set<string> | null; zoom: number; query: string },
): boolean {
  if (state.hovered) return true;
  if (n.kind === "comment") return false;
  if (state.focus) return state.focus.has(n.id);
  return state.zoom > LABELS_FROM_ZOOM || (state.query !== "" && matches(n, state.query));
}

/** Screen coordinates (relative to the canvas) to world coordinates. */
export function toWorld(view: View, screen: { x: number; y: number }): { x: number; y: number } {
  return { x: (screen.x - view.x) / view.k, y: (screen.y - view.y) / view.k };
}

/** The node nearest a world point, if the point is on it (or within a few screen pixels of it). */
export function nodeAt(nodes: Node[], point: { x: number; y: number }, zoom: number): Node | null {
  let best: Node | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const n of nodes) {
    const d = Math.hypot((n.x ?? 0) - point.x, (n.y ?? 0) - point.y);
    if (d < radius(n) + HIT_SLOP_PX / zoom && d < bestDistance) {
      best = n;
      bestDistance = d;
    }
  }
  return best;
}

/** The view after a wheel turn at `mouse` (canvas coordinates), zooming about the pointer. */
export function zoomView(view: View, mouse: { x: number; y: number }, deltaY: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * Math.exp(-deltaY * WHEEL_ZOOM_SPEED)));
  return { k, x: mouse.x - ((mouse.x - view.x) / view.k) * k, y: mouse.y - ((mouse.y - view.y) / view.k) * k };
}
