/**
 * The link graph, drawn like the app's: each note as a round tile with its icon in its colour, tags and the linked page
 * comment around them, and a line for every [[link]] and #tag. Built from the notes' text with the viewer's own parser,
 * so links and tags typed in the editor show up. Click a note to open it.
 */
import type { IconNode } from "lucide";
import { extractLinks, extractTags } from "../../../../viewer/src/docs/docMarkdown";
import { $ } from "../../lib/dom";
import { reducedMotion } from "../../lib/scene";
import { iconNode } from "./icons";
import { TAG_STYLES, type Note } from "./notes";

const SVG = "http://www.w3.org/2000/svg";
const CENTRE = { x: 200, y: 175 };

/** Where each note sits; tags and the comment go on a ring around them. */
const SPOTS: Record<string, { x: number; y: number }> = {
  qa: { x: 200, y: 170 }, banner: { x: 95, y: 120 }, spec: { x: 300, y: 110 },
  release: { x: 120, y: 245 }, payments: { x: 295, y: 245 }, design: { x: 345, y: 175 },
};

interface GraphNode {
  key: string;
  label: string;
  kind: "note" | "comment" | "tag";
  icon: IconNode;
  color: string;
  x: number;
  y: number;
  phase: number;
  g: SVGGElement;
}

export function linkGraph(onOpen: (noteId: string) => void) {
  const svg = $<SVGSVGElement>("#graph-svg");
  const root = $("#graph");
  const edgeLayer = document.createElementNS(SVG, "g");
  const nodeLayer = document.createElementNS(SVG, "g");
  svg.replaceChildren(edgeLayer, nodeLayer);
  const nodes = new Map<string, GraphNode>();
  let edges: { a: GraphNode; b: GraphNode; line: SVGLineElement }[] = [];
  let active = "";

  const tile = (n: Omit<GraphNode, "g" | "phase">): GraphNode => {
    const existing = nodes.get(n.key);
    if (existing) return Object.assign(existing, n);
    const g = document.createElementNS(SVG, "g");
    g.setAttribute("class", `gnode gnode-${n.kind}`);
    nodeLayer.append(g);
    const node = { ...n, g, phase: Math.random() * 6 };
    if (n.kind === "note") g.addEventListener("click", () => onOpen(n.key.slice(5)));
    nodes.set(n.key, node);
    return node;
  };

  /** Each node's drawing: a tinted circle outlined in its colour, the icon inside, the name below. */
  const draw = (n: GraphNode) => {
    const r = n.kind === "note" ? (n.key === `note:${active}` ? 17 : 14) : 11;
    const size = r * 1.15;
    n.g.style.setProperty("--c", n.color);
    n.g.classList.toggle("active", n.key === `note:${active}`);
    n.g.innerHTML = `<circle r="${r}" class="gtile"></circle><circle r="${r}" class="gring"></circle>`
      + `<svg x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gicon">`
      + n.icon.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${String(v)}"`).join(" ")}/>`).join("")
      + `</svg><text y="${r + 12}" text-anchor="middle"></text>`;
    n.g.querySelector("text")!.textContent = n.label;
  };

  const update = (notes: Note[], activeId: string) => {
    active = activeId;
    const shown = new Set<string>();
    const pairs: [string, string][] = [];
    const byTitle = new Map(notes.map((n) => [n.title.toLowerCase(), n]));
    for (const note of notes) {
      const key = `note:${note.id}`;
      shown.add(key);
      tile({ key, label: note.title.replace(/:.*/, ""), kind: "note", icon: iconNode(note.icon), color: note.color, ...SPOTS[note.id]! });
      for (const link of extractLinks(note.content)) {
        if (link.commentId) {
          shown.add("comment");
          pairs.push([key, "comment"]);
        } else {
          const target = byTitle.get(link.target!.toLowerCase());
          if (target) pairs.push([key, `note:${target.id}`]);
        }
      }
      for (const tag of extractTags(note.content)) {
        shown.add(`tag:${tag}`);
        pairs.push([key, `tag:${tag}`]);
      }
    }
    // The comment and the tags on a ring around the notes, in a steady order.
    const outer = ["comment", ...[...shown].filter((k) => k.startsWith("tag:")).sort()].filter((k) => shown.has(k));
    outer.forEach((key, i) => {
      const angle = -Math.PI * 0.9 + (i / Math.max(outer.length, 1)) * Math.PI * 2;
      const spot = { x: CENTRE.x + Math.cos(angle) * 170, y: CENTRE.y + Math.sin(angle) * 140 };
      if (key === "comment") tile({ key, label: "#4 Rosie", kind: "comment", icon: iconNode("message-square"), color: "#ef4444", ...spot });
      else {
        const tag = key.slice(4);
        const style = TAG_STYLES[tag] ?? {};
        tile({ key, label: `#${tag}`, kind: "tag", icon: iconNode(style.icon ?? "hash"), color: style.color ?? "#10b981", ...spot });
      }
    });
    for (const [key, n] of nodes) {
      if (!shown.has(key)) {
        n.g.remove();
        nodes.delete(key);
      } else draw(n);
    }
    for (const e of edges) e.line.remove();
    const seen = new Set<string>();
    edges = pairs.filter(([a, b]) => a !== b && nodes.has(a) && nodes.has(b) && !seen.has(`${a}>${b}`) && seen.add(`${a}>${b}`)).map(([a, b]) => {
      const line = document.createElementNS(SVG, "line");
      const lit = a === `note:${active}` || b === `note:${active}`;
      line.setAttribute("class", lit ? "edge hot" : "edge");
      edgeLayer.append(line);
      return { a: nodes.get(a)!, b: nodes.get(b)!, line };
    });
  };

  // Nodes drift a little, like the app's graph settling.
  const frame = (time: number) => {
    const box = root.getBoundingClientRect();
    if (box.bottom > 0 && box.top < innerHeight) {
      const t = reducedMotion ? 0 : time / 1000;
      const at = new Map<GraphNode, { x: number; y: number }>();
      for (const n of nodes.values()) {
        const p = { x: n.x + Math.sin(t * 0.7 + n.phase) * 3, y: n.y + Math.cos(t * 0.6 + n.phase) * 3 };
        at.set(n, p);
        n.g.setAttribute("transform", `translate(${p.x},${p.y})`);
      }
      for (const { a, b, line } of edges) {
        line.setAttribute("x1", String(at.get(a)!.x));
        line.setAttribute("y1", String(at.get(a)!.y));
        line.setAttribute("x2", String(at.get(b)!.x));
        line.setAttribute("y2", String(at.get(b)!.y));
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return { update };
}
