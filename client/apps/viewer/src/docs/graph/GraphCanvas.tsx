import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation } from "d3-force";
import { useEffect, useMemo, useRef } from "react";
import { navigate } from "@/lib/router";
import { type IconLibrary, useIcons } from "../docIcons";
import type { DocGraph, DocTree } from "../docsApi";
import { drawGraph, readPalette, type Scene } from "./drawGraph";
import {
  buildGraph,
  type Edge,
  type GraphOptions,
  type Node,
  neighboursOf,
  nodeAt,
  radius,
  toWorld,
  zoomView,
} from "./graphModel";

/** A press that moves less than this (screen pixels) is a click, not a drag. */
const CLICK_SLOP_PX = 3;

export interface GraphCanvasProps extends GraphOptions {
  orgId: string;
  graph: DocGraph;
  tree: DocTree;
  /** Highlight docs whose title contains this. */
  filter: string;
}

interface Drag {
  node: Node | null;
  startX: number;
  startY: number;
  moved: boolean;
  viewX: number;
  viewY: number;
}

/** The force-directed graph on a canvas: drag to pan, scroll to zoom, drag a node to move it, click to open it. */
export function GraphCanvas({ orgId, graph, tree, showComments, showTags, onlyTags, filter }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const data = useMemo(
    () => buildGraph(orgId, graph, tree, { showComments, showTags, onlyTags }),
    [orgId, graph, tree, showComments, showTags, onlyTags],
  );
  const filterRef = useRef(filter);
  filterRef.current = filter.trim().toLowerCase();
  const redraw = useRef<() => void>(() => undefined);
  // The icon set loads after the page; until then nodes are plain dots.
  const library = useIcons();
  const libraryRef = useRef<IconLibrary | null>(library);
  libraryRef.current = library;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { nodes, edges } = data;
    const scene: Scene = {
      nodes,
      edges,
      neighbours: neighboursOf(nodes, edges),
      view: { x: 0, y: 0, k: 1 },
      width: 0,
      height: 0,
      hover: null,
      query: "",
      palette: readPalette(),
      icons: null,
    };
    let dragging: Drag | null = null;
    let frame = 0;

    const draw = () => {
      scene.query = filterRef.current;
      scene.icons = libraryRef.current;
      drawGraph(ctx, scene);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      scene.width = rect.width;
      scene.height = rect.height;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (scene.view.x === 0 && scene.view.y === 0) scene.view = { x: rect.width / 2, y: rect.height / 2, k: 1 };
      draw();
    };

    const simulation = forceSimulation(nodes)
      .force(
        "link",
        forceLink<Node, Edge>(edges)
          .id((n) => n.id)
          .distance(70)
          .strength(0.4),
      )
      .force("charge", forceManyBody().strength(-140))
      .force("center", forceCenter(0, 0))
      .force(
        "collide",
        forceCollide<Node>().radius((n) => radius(n) + 4),
      )
      .on("tick", schedule);

    const worldAt = (e: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return toWorld(scene.view, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    const hit = (e: PointerEvent) => nodeAt(nodes, worldAt(e), scene.view.k);

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      const node = hit(e);
      const { x: viewX, y: viewY } = scene.view;
      dragging = { node, startX: e.clientX, startY: e.clientY, moved: false, viewX, viewY };
      if (node) {
        simulation.alphaTarget(0.3).restart();
        node.fx = node.x;
        node.fy = node.y;
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragging) {
        drag(dragging, e);
        schedule();
        return;
      }
      const node = hit(e);
      if (node === scene.hover) return;
      scene.hover = node;
      canvas.style.cursor = node?.href ? "pointer" : "grab";
      schedule();
    };
    /** Moves the dragged node, or pans the view when the drag started on empty space. */
    const drag = (d: Drag, e: PointerEvent) => {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > CLICK_SLOP_PX) d.moved = true;
      if (d.node) {
        const p = worldAt(e);
        d.node.fx = p.x;
        d.node.fy = p.y;
      } else {
        scene.view.x = d.viewX + (e.clientX - d.startX);
        scene.view.y = d.viewY + (e.clientY - d.startY);
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
      const href = current && !current.moved ? current.node?.href : null;
      if (!href) return;
      if (e.metaKey || e.ctrlKey) window.open(href, "_blank", "noopener");
      else navigate(href);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      scene.view = zoomView(scene.view, { x: e.clientX - rect.left, y: e.clientY - rect.top }, e.deltaY);
      schedule();
    };
    const onScheme = () => {
      scene.palette = readPalette();
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

  // Redraw when the highlight text changes, and when the icons arrive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these are what the drawing depends on; redraw is a ref
  useEffect(() => redraw.current(), [filter, library]);

  return (
    <canvas ref={canvasRef} className="block size-full cursor-grab touch-none" aria-label="Graph of docs and links" />
  );
}
