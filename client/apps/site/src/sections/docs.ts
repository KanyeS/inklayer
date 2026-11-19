/**
 * Docs: John and Rosie write in the same doc at once (each with a named caret); John's [[link]] adds a node to the link
 * graph beside it.
 */
import { $, h } from "../lib/dom";
import { JOHN, ROSIE, type Person } from "../lib/people";
import { type Ctx, reducedMotion, scene, together } from "../lib/scene";

interface GraphNode {
  x: number;
  y: number;
  label: string;
  type?: "me" | "comment" | "tag";
  /** Appears when John links to it. */
  late?: boolean;
}

const NODES: Record<string, GraphNode> = {
  qa: { x: 200, y: 165, label: "QA notes", type: "me" },
  banner: { x: 85, y: 85, label: "Cookie banner" },
  spec: { x: 315, y: 70, label: "Checkout spec" },
  system: { x: 340, y: 205, label: "Design system" },
  c4: { x: 95, y: 235, label: "#4 Rosie", type: "comment" },
  c5: { x: 190, y: 300, label: "#5 Leo", type: "comment" },
  checkout: { x: 200, y: 45, label: "#checkout", type: "tag" },
  mobile: { x: 45, y: 160, label: "#mobile", type: "tag" },
  release: { x: 330, y: 290, label: "Release checklist", late: true },
};
/** The graph's CSS classes for each kind of node (see .graph .node in styles.css). */
const NODE_CLASS = { me: "me", comment: "c", tag: "t" } as const;

const EDGES: [string, string][] = [
  ["qa", "banner"], ["qa", "c4"], ["qa", "checkout"], ["qa", "mobile"], ["banner", "c4"], ["spec", "checkout"], ["spec", "system"],
  ["qa", "spec"], ["c5", "spec"], ["banner", "mobile"], ["qa", "release"], ["release", "c5"],
];

export function docs(): void {
  const lines = [$("#doc-l1"), $("#doc-l2")];
  const graph = linkGraph();

  /** A named caret in the person's colour; text typed goes in just before it. */
  const writer = (line: HTMLElement, person: Person) => {
    const caret = h("span", { className: "typing-caret", style: { "--c": person.color } }, h("b", { textContent: person.name }));
    line.append(caret);
    return {
      type: async (ctx: Ctx, text: string, speed: number) => {
        const node = document.createTextNode("");
        line.insertBefore(node, caret);
        await ctx.type(text, (s) => (node.data = s), speed);
      },
      insert: (el: HTMLElement) => line.insertBefore(el, caret),
      done: () => caret.remove(),
    };
  };
  const reset = () => {
    for (const line of lines) line.replaceChildren();
    graph.showLinked(false);
  };
  reset();

  scene($("#docs"), async (ctx) => {
    reset();
    const john = writer(lines[0]!, JOHN);
    const rosie = writer(lines[1]!, ROSIE);
    await together(
      (async () => {
        await john.type(ctx, "Fix: lift the banner above the safe area and give the pay button 24 px of clearance. Tracked in ", 24);
        john.insert(h("span", { className: "wl", textContent: "[[Release checklist]]" }));
        graph.showLinked(true);
        await john.type(ctx, ".", 10);
      })(),
      (async () => {
        await ctx.sleep(1800);
        await rosie.type(ctx, "Retest on iPhone SE, Pixel 4a and a 320 px window, then ", 20);
        rosie.insert(h("span", { className: "mention", textContent: "@Michael" }));
        await rosie.type(ctx, " can ship it.", 18);
      })(),
    );
    await ctx.sleep(1500);
    john.done();
    rosie.done();
    await ctx.sleep(4000);
  }, { gap: 400, reset });
}

/** The docs graph: nodes drift gently; the late node and its links appear when linked. */
function linkGraph() {
  const SVG = "http://www.w3.org/2000/svg";
  const svg = $<SVGSVGElement>("#graph-svg");
  const root = $("#graph");
  const edges = EDGES.map(([a, b]) => {
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("class", NODES[a]!.late || NODES[b]!.late ? "edge late" : "edge");
    svg.append(line);
    return { line, a: NODES[a]!, b: NODES[b]! };
  });
  const nodes = Object.values(NODES).map((node) => {
    const g = document.createElementNS(SVG, "g");
    g.setAttribute("class", `node ${node.type ? NODE_CLASS[node.type] : ""}`);
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("r", node.type === "me" ? "9" : "7");
    const label = document.createElementNS(SVG, "text");
    label.textContent = node.label;
    label.setAttribute("x", "12");
    label.setAttribute("y", "4");
    g.append(circle, label);
    svg.append(g);
    return { node, g, phase: Math.random() * 6 };
  });
  let linked = false;
  const positions = new Map<GraphNode, { x: number; y: number }>();

  const frame = (time: number) => {
    const box = root.getBoundingClientRect();
    if (box.bottom > 0 && box.top < innerHeight) {
      const t = reducedMotion ? 0 : time / 1000;
      for (const n of nodes) {
        const at = { x: n.node.x + Math.sin(t * 0.7 + n.phase) * 4, y: n.node.y + Math.cos(t * 0.6 + n.phase) * 4 };
        positions.set(n.node, at);
        n.g.setAttribute("transform", `translate(${at.x},${at.y})`);
        n.g.style.display = n.node.late && !linked ? "none" : "";
      }
      for (const e of edges) {
        const a = positions.get(e.a)!;
        const b = positions.get(e.b)!;
        e.line.setAttribute("x1", String(a.x));
        e.line.setAttribute("y1", String(a.y));
        e.line.setAttribute("x2", String(b.x));
        e.line.setAttribute("y2", String(b.y));
        const late = e.a.late || e.b.late;
        e.line.style.display = late && !linked ? "none" : "";
        e.line.classList.toggle("hot", !!late && linked);
      }
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return { showLinked: (on: boolean) => (linked = on) };
}
