import { type IconLibrary, iconPath } from "../docIcons";
import { type Edge, labelVisible, matches, type Node, radius, shortLabel, type View } from "./graphModel";

/** Painting the docs graph on a canvas: links, then nodes, then labels. */

/** The theme's colours, read from its CSS variables (they change with dark mode). */
export interface Palette {
  doc: string;
  text: string;
  muted: string;
  line: string;
  comment: string;
  tag: string;
  bg: string;
}

export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  // Docs without a colour of their own: the theme's bright violet, which reads on light and dark backgrounds.
  return {
    doc: v("--chart-2"),
    text: v("--foreground"),
    muted: v("--muted-foreground"),
    line: v("--border"),
    comment: "#E8A100",
    tag: "#0ACF83",
    bg: v("--background"),
  };
}

/** Everything one frame of the graph depends on. */
export interface Scene {
  nodes: Node[];
  edges: Edge[];
  neighbours: Map<string, Set<string>>;
  view: View;
  width: number;
  height: number;
  hover: Node | null;
  /** The highlight text, trimmed and lower-cased. */
  query: string;
  palette: Palette;
  icons: IconLibrary | null;
}

function colorOf(n: Node, palette: Palette): string {
  if (n.color) return n.color;
  if (n.kind === "doc") return palette.doc;
  return n.kind === "tag" ? palette.tag : palette.comment;
}

export function drawGraph(ctx: CanvasRenderingContext2D, scene: Scene): void {
  const { view, hover } = scene;
  ctx.save();
  ctx.clearRect(0, 0, scene.width, scene.height);
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);
  const focus = hover ? (scene.neighbours.get(hover.id) ?? null) : null;
  drawEdges(ctx, scene, focus);
  for (const n of scene.nodes) {
    const dim = (focus && !focus.has(n.id)) || !matches(n, scene.query);
    drawNode(ctx, n, { alpha: dim ? 0.2 : 1, hovered: n === hover, palette: scene.palette, icons: scene.icons });
  }
  drawLabels(ctx, scene, focus);
  ctx.restore();
}

/** Links: those of the hovered node in its colour; the rest faded while something is hovered or highlighted. */
function drawEdges(
  ctx: CanvasRenderingContext2D,
  { edges, hover, query, palette, view }: Scene,
  focus: Set<string> | null,
) {
  ctx.lineWidth = 1 / view.k;
  for (const e of edges) {
    const s = e.source as Node;
    const t = e.target as Node;
    const lit = hover !== null && (s.id === hover.id || t.id === hover.id);
    ctx.strokeStyle = lit && hover ? colorOf(hover, palette) : palette.line;
    ctx.globalAlpha = focus && !lit ? 0.25 : query ? 0.35 : 0.9;
    ctx.beginPath();
    ctx.moveTo(s.x ?? 0, s.y ?? 0);
    ctx.lineTo(t.x ?? 0, t.y ?? 0);
    ctx.stroke();
  }
}

/** Labels when zoomed in, for the hovered node and its neighbours, and for highlighted docs. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  { nodes, hover, query, palette, view }: Scene,
  focus: Set<string> | null,
) {
  ctx.font = `${12 / view.k}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const n of nodes) {
    if (!labelVisible(n, { hovered: n === hover, focus, zoom: view.k, query })) continue;
    ctx.globalAlpha = focus && !focus.has(n.id) ? 0.2 : 1;
    ctx.fillStyle = n === hover ? palette.text : palette.muted;
    ctx.fillText(shortLabel(n.label), n.x ?? 0, (n.y ?? 0) + radius(n) + 3 / view.k);
  }
}

/** A round tile tinted and outlined in the node's colour, with its icon drawn inside in the same colour. */
function drawNode(
  ctx: CanvasRenderingContext2D,
  n: Node,
  o: { alpha: number; hovered: boolean; palette: Palette; icons: IconLibrary | null },
): void {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const r = radius(n);
  const color = colorOf(n, o.palette);
  const icon = o.icons?.get(n.icon);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.globalAlpha = o.alpha;
  if (!icon) {
    // Until the icons load: a plain dot.
    ctx.fillStyle = o.hovered ? o.palette.text : color;
    ctx.fill();
    return;
  }
  ctx.fillStyle = o.palette.bg;
  ctx.fill();
  ctx.globalAlpha = o.alpha * (o.hovered ? 0.24 : 0.12);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = o.alpha;
  ctx.lineWidth = o.hovered ? 2 : 1.25;
  ctx.strokeStyle = color;
  ctx.stroke();

  // Lucide icons are drawn on a 24×24 grid with 2-unit strokes.
  const size = r * 1.25;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(iconPath(icon));
  ctx.restore();
}
