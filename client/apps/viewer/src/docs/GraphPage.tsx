import { useEffect, useMemo, useRef, useState } from "react";
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { ArrowLeft } from "lucide-react";
import { Button } from "@inklayer/ui/components/button";
import { Checkbox } from "@inklayer/ui/components/checkbox";
import { Input } from "@inklayer/ui/components/input";
import { Label } from "@inklayer/ui/components/label";
import { ErrorText, Loading } from "@/components/Layout";
import { Link, navigate } from "@/lib/router";
import { useAsync } from "@/lib/useAsync";
import { docPath, docsApi, type DocGraph, type DocTree } from "./docsApi";

interface Node extends SimulationNodeDatum {
  id: string;
  kind: "doc" | "comment" | "tag";
  label: string;
  href: string | null;
  degree: number;
}

type Edge = SimulationLinkDatum<Node>;

/**
 * The organisation's docs as a graph, like Obsidian's: a dot per doc, sized by how linked it is, and a line per link.
 * Comments that link docs (or are linked from them) and tags can be shown too. Drag to pan, scroll to zoom, drag a dot
 * to move it, hover to see its neighbours, click to open.
 */
export function GraphPage({ orgId }: { orgId: string }) {
  const graph = useAsync(() => docsApi.graph(orgId), [orgId]);
  const tree = useAsync(() => docsApi.tree(orgId), [orgId]);
  const [showComments, setShowComments] = useState(true);
  const [showTags, setShowTags] = useState(false);
  const [filter, setFilter] = useState("");

  if (graph.error || tree.error) return <div className="p-6"><ErrorText error={graph.error ?? tree.error} /></div>;
  if (!graph.data || !tree.data) return <div className="p-6"><Loading /></div>;

  return (
    <div className="relative h-[calc(100svh-3.5rem)] overflow-hidden">
      <div className="absolute top-4 left-4 z-10 flex w-64 flex-col gap-3 rounded-2xl border bg-background/90 p-4 shadow-sm backdrop-blur">
        <Button variant="ghost" size="sm" className="-ml-2 self-start" nativeButton={false} render={<Link to={`/orgs/${orgId}/docs`} />}>
          <ArrowLeft data-icon="inline-start" />Docs
        </Button>
        <Input placeholder="Highlight docs…" aria-label="Highlight docs whose title contains" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <Label className="flex items-center gap-2 font-normal"><Checkbox checked={showComments} onCheckedChange={(v) => setShowComments(v === true)} />Page comments</Label>
        <Label className="flex items-center gap-2 font-normal"><Checkbox checked={showTags} onCheckedChange={(v) => setShowTags(v === true)} />Tags</Label>
        <p className="text-xs text-muted-foreground">{graph.data.nodes.filter((n) => n.kind === "doc").length} docs · {graph.data.edges.length} links</p>
      </div>
      <GraphCanvas orgId={orgId} graph={graph.data} tree={tree.data} showComments={showComments} showTags={showTags} filter={filter} />
    </div>
  );
}

function buildGraph(orgId: string, graph: DocGraph, tree: DocTree, showComments: boolean, showTags: boolean): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = graph.nodes
    .filter((n) => n.kind === "doc" || showComments)
    .map((n) => ({
      id: n.id, kind: n.kind, label: n.label, degree: 0,
      href: n.kind === "doc" ? docPath(orgId, n.docId!) : `/comments/${n.annotationId}`,
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: Edge[] = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ source: e.source, target: e.target }));
  if (showTags) {
    const tags = new Set(tree.docs.flatMap((d) => d.tags));
    for (const tag of tags) nodes.push({ id: `t:${tag}`, kind: "tag", label: `#${tag}`, href: null, degree: 0 });
    for (const d of tree.docs) for (const tag of d.tags) if (ids.has(`d:${d.id}`)) edges.push({ source: `d:${d.id}`, target: `t:${tag}` });
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    byId.get(e.source as string)!.degree++;
    byId.get(e.target as string)!.degree++;
  }
  return { nodes, edges };
}

const radius = (n: Node) => (n.kind === "doc" ? 4 + Math.sqrt(n.degree) * 2.2 : n.kind === "tag" ? 4 : 3);

function GraphCanvas({ orgId, graph, tree, showComments, showTags, filter }: {
  orgId: string;
  graph: DocGraph;
  tree: DocTree;
  showComments: boolean;
  showTags: boolean;
  filter: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const data = useMemo(() => buildGraph(orgId, graph, tree, showComments, showTags), [orgId, graph, tree, showComments, showTags]);
  const filterRef = useRef(filter);
  filterRef.current = filter.trim().toLowerCase();
  const redraw = useRef<() => void>(() => undefined);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const { nodes, edges } = data;
    const neighbours = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set([n.id])]));
    for (const e of edges) {
      neighbours.get(e.source as string)!.add(e.target as string);
      neighbours.get(e.target as string)!.add(e.source as string);
    }

    let width = 0;
    let height = 0;
    let view = { x: 0, y: 0, k: 1 };
    let hover: Node | null = null;
    let dragging: { node: Node | null; startX: number; startY: number; moved: boolean; viewX: number; viewY: number } | null = null;
    let frame = 0;

    const colors = () => {
      const style = getComputedStyle(document.documentElement);
      const v = (name: string) => style.getPropertyValue(name).trim();
      return { doc: v("--primary"), text: v("--foreground"), muted: v("--muted-foreground"), line: v("--border"), comment: "#E8A100", tag: "#0ACF83", bg: v("--background") };
    };
    let palette = colors();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (view.x === 0 && view.y === 0) view = { x: width / 2, y: height / 2, k: 1 };
      draw();
    };

    const draw = () => {
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      ctx.translate(view.x, view.y);
      ctx.scale(view.k, view.k);
      const focus = hover ? neighbours.get(hover.id)! : null;
      const q = filterRef.current;
      const matches = (n: Node) => !q || n.label.toLowerCase().includes(q);

      ctx.lineWidth = 1 / view.k;
      for (const e of edges) {
        const s = e.source as Node;
        const t = e.target as Node;
        const lit = focus ? focus.has(s.id) && focus.has(t.id) && (s.id === hover!.id || t.id === hover!.id) : false;
        ctx.strokeStyle = lit ? palette.doc : palette.line;
        ctx.globalAlpha = focus && !lit ? 0.25 : q ? 0.35 : 0.9;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.stroke();
      }

      for (const n of nodes) {
        const dim = (focus && !focus.has(n.id)) || !matches(n);
        ctx.globalAlpha = dim ? 0.2 : 1;
        ctx.fillStyle = n.kind === "doc" ? (n === hover ? palette.text : palette.doc) : n.kind === "tag" ? palette.tag : palette.comment;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, radius(n), 0, Math.PI * 2);
        ctx.fill();
      }

      // Labels when zoomed in, for the hovered node and its neighbours, and for highlighted docs.
      ctx.font = `${12 / view.k}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (const n of nodes) {
        const show = (focus ? focus.has(n.id) : view.k > 0.9 || (q !== "" && matches(n))) && n.kind !== "comment" || n === hover;
        if (!show) continue;
        ctx.globalAlpha = focus && !focus.has(n.id) ? 0.2 : 1;
        ctx.fillStyle = n === hover ? palette.text : palette.muted;
        const label = n.label.length > 40 ? `${n.label.slice(0, 40)}…` : n.label;
        ctx.fillText(label, n.x!, n.y! + radius(n) + 3 / view.k);
      }
      ctx.restore();
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };

    const simulation: Simulation<Node, Edge> = forceSimulation(nodes)
      .force("link", forceLink<Node, Edge>(edges).id((n) => n.id).distance(60).strength(0.4))
      .force("charge", forceManyBody().strength(-140))
      .force("center", forceCenter(0, 0))
      .force("collide", forceCollide<Node>().radius((n) => radius(n) + 4))
      .on("tick", schedule);

    const toWorld = (event: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return { x: (event.clientX - rect.left - view.x) / view.k, y: (event.clientY - rect.top - view.y) / view.k };
    };
    const nodeAt = (event: { clientX: number; clientY: number }) => {
      const p = toWorld(event);
      let best: Node | null = null;
      let bestDistance = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y);
        if (d < radius(n) + 6 / view.k && d < bestDistance) {
          best = n;
          bestDistance = d;
        }
      }
      return best;
    };

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const node = nodeAt(e);
      dragging = { node, startX: e.clientX, startY: e.clientY, moved: false, viewX: view.x, viewY: view.y };
      if (node) {
        simulation.alphaTarget(0.3).restart();
        node.fx = node.x;
        node.fy = node.y;
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragging) {
        if (Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > 3) dragging.moved = true;
        if (dragging.node) {
          const p = toWorld(e);
          dragging.node.fx = p.x;
          dragging.node.fy = p.y;
        } else {
          view.x = dragging.viewX + (e.clientX - dragging.startX);
          view.y = dragging.viewY + (e.clientY - dragging.startY);
        }
        schedule();
        return;
      }
      const node = nodeAt(e);
      if (node !== hover) {
        hover = node;
        canvas.style.cursor = node?.href ? "pointer" : "grab";
        schedule();
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      const current = dragging;
      dragging = null;
      if (current?.node) {
        simulation.alphaTarget(0);
        current.node.fx = null;
        current.node.fy = null;
      }
      if (current && !current.moved && current.node?.href) {
        if (e.metaKey || e.ctrlKey) window.open(current.node.href, "_blank", "noopener");
        else navigate(current.node.href);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const k = Math.min(4, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0015)));
      view = { k, x: mx - ((mx - view.x) / view.k) * k, y: my - ((my - view.y) / view.k) * k };
      schedule();
    };
    const onScheme = () => {
      palette = colors();
      schedule();
    };

    redraw.current = schedule;
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", onScheme);
    return () => {
      simulation.stop();
      observer.disconnect();
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      scheme.removeEventListener("change", onScheme);
    };
  }, [data]);

  // Redraw when the highlight text changes.
  useEffect(() => redraw.current(), [filter]);

  return <canvas ref={canvasRef} className="block size-full cursor-grab touch-none" aria-label="Graph of docs and links" />;
}
