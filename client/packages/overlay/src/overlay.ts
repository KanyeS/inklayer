import { getStroke } from "perfect-freehand";
import { anchorFor, documentBox, resolveElement, resolveRange } from "./anchoring";
import { boundsOf, contains, fromFraction, normaliseRect, toFraction } from "./geometry";
import type { AnchorQuality, Box, Draft, Geometry, HostMessage, OverlayAnnotation, OverlayMessage, Point, Tool } from "./types";

const SVG_NS = "http://www.w3.org/2000/svg";
const INK_SIZE = 6;
const DRAWING_TOOLS: ReadonlySet<Tool> = new Set(["rect", "arrow", "ink"]);

interface Resolved {
  key: string;
  element: Element | null;
  range: Range | null;
  quality: AnchorQuality;
}

export interface OverlayOptions {
  /** Elements whose events the tools ignore, such as the extension's own panel. */
  ignoreEventsFrom?: Element[];
}

/**
 * Draws annotations on top of a web page (through the extension) and implements the drawing tools. Everything lives in a closed shadow
 * root on one host element, so the page's CSS can't restyle the overlay and the overlay can't disturb the page.
 * Annotation positions are recalculated from their anchors whenever the layout changes.
 */
export class Overlay {
  readonly #doc: Document;
  readonly #send: (message: OverlayMessage) => void;
  readonly #host: HTMLElement;
  readonly #svg: SVGSVGElement;
  readonly #badges: HTMLDivElement;
  readonly #hover: HTMLDivElement;
  readonly #surface: HTMLDivElement;
  readonly #resolved = new Map<string, Resolved>();
  readonly #cleanup: (() => void)[] = [];
  readonly #ignored: Element[];

  #annotations: OverlayAnnotation[] = [];
  #tool: Tool = "select";
  #color = "#f59e0b";
  #selected: string | null = null;
  #draft: Draft | null = null;
  #preview: { tool: Tool; points: [number, number, number][] } | null = null;
  #frame = 0;
  #positions = new Map<string, Point>();
  #sentPositions = "";

  constructor(doc: Document, send: (message: OverlayMessage) => void, options: OverlayOptions = {}) {
    this.#doc = doc;
    this.#send = send;
    this.#ignored = options.ignoreEventsFrom ?? [];

    this.#host = doc.createElement("inklayer-overlay");
    this.#host.setAttribute("style", "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;");
    const shadow = this.#host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${STYLES}</style>`;
    this.#svg = doc.createElementNS(SVG_NS, "svg");
    this.#svg.setAttribute("class", "shapes");
    this.#badges = doc.createElement("div");
    this.#hover = doc.createElement("div");
    this.#hover.className = "hover";
    this.#surface = doc.createElement("div");
    this.#surface.className = "surface";
    shadow.append(this.#svg, this.#badges, this.#hover, this.#surface);
    doc.documentElement.append(this.#host);

    this.#listen();
    this.render();
  }

  handle(message: HostMessage): void {
    switch (message.type) {
      case "setAnnotations":
        this.#annotations = message.annotations;
        this.#draft = null;
        this.#resolveAll();
        break;
      case "setTool":
        this.#tool = message.tool;
        this.#color = message.color;
        this.#surface.style.pointerEvents = DRAWING_TOOLS.has(message.tool) ? "auto" : "none";
        this.#hover.style.display = "none";
        break;
      case "select":
        this.#selected = message.id;
        if (message.scroll && message.id) this.#scrollIntoView(message.id);
        break;
      case "clearDraft":
        this.#draft = null;
        break;
      case "scrollTo":
        this.#doc.defaultView?.scrollTo(message.x, message.y);
        break;
    }
    this.render();
  }

  destroy(): void {
    for (const fn of this.#cleanup) fn();
    this.#host.remove();
  }

  /** Finds every annotation's element again, after the page has changed its DOM. */
  reanchor(): void {
    this.#resolved.clear();
    this.#resolveAll();
    this.render();
  }

  /** Puts the overlay back if the page removed it (some apps replace html's children). Returns true if it had to. */
  ensureAttached(): boolean {
    if (this.#host.isConnected) return false;
    this.#doc.documentElement.append(this.#host);
    return true;
  }

  #isIgnored(event: Event): boolean {
    return this.#ignored.length > 0 && event.composedPath().some((node) => this.#ignored.includes(node as Element));
  }

  /** Shows or hides every mark without forgetting them. */
  setVisible(visible: boolean): void {
    this.#host.style.display = visible ? "" : "none";
  }

  /* ---------------------------------------------------------------- anchoring */

  #resolveAll(): void {
    const quality: Record<string, AnchorQuality> = {};
    for (const annotation of this.#annotations) {
      const key = JSON.stringify(annotation.anchor);
      let entry = this.#resolved.get(annotation.id);
      if (!entry || entry.key !== key) {
        const { element, quality: elementQuality } = resolveElement(this.#doc, annotation.anchor.element);
        let range: Range | null = null;
        let q = elementQuality;
        if (annotation.anchor.text) {
          const text = element ? resolveRange(element, annotation.anchor.text) : { range: null, quality: "orphaned" as const };
          range = text.range;
          q = !range ? "orphaned" : text.quality === "exact" && elementQuality === "exact" ? "exact" : "fallback";
        }
        entry = { key, element, range, quality: q };
        this.#resolved.set(annotation.id, entry);
      }
      quality[annotation.id] = entry.quality;
    }
    this.#send({ type: "anchors", quality });
  }

  #boxFor(annotation: { anchor: OverlayAnnotation["anchor"] }, resolved?: Resolved): Box {
    return resolved?.element ? documentBox(resolved.element) : annotation.anchor.element.box;
  }

  /* ---------------------------------------------------------------- rendering */

  render = (): void => {
    cancelAnimationFrame(this.#frame);
    this.#frame = requestAnimationFrame(() => this.#draw());
  };

  #draw(): void {
    const root = this.#doc.documentElement;
    // Collapse the overlay before measuring, so its own size never props the page open.
    for (const el of [this.#svg, this.#surface]) {
      el.setAttribute("width", "0");
      el.setAttribute("height", "0");
    }
    this.#surface.style.width = "0";
    this.#surface.style.height = "0";
    const width = Math.max(root.scrollWidth, this.#doc.body?.scrollWidth ?? 0);
    const height = Math.max(root.scrollHeight, this.#doc.body?.scrollHeight ?? 0);
    this.#svg.setAttribute("width", String(width));
    this.#svg.setAttribute("height", String(height));
    this.#surface.style.width = `${width}px`;
    this.#surface.style.height = `${height}px`;
    this.#svg.replaceChildren();
    this.#badges.replaceChildren();
    this.#positions.clear();

    for (const annotation of this.#annotations) {
      const resolved = this.#resolved.get(annotation.id);
      this.#drawOne(annotation, this.#boxFor(annotation, resolved), resolved?.range ?? null, {
        draft: false,
        selected: annotation.id === this.#selected,
        faded: annotation.resolved,
        orphaned: resolved?.quality === "orphaned",
      });
    }

    if (this.#draft) {
      const { anchor, geometry, kind } = this.#draft;
      const resolved = resolveElement(this.#doc, anchor.element);
      const range = anchor.text && resolved.element ? resolveRange(resolved.element, anchor.text).range : null;
      this.#drawOne({ id: "", kind, color: this.#color, resolved: false, label: 0, anchor, geometry },
        resolved.element ? documentBox(resolved.element) : anchor.element.box, range, { draft: true, selected: true, faded: false, orphaned: false });
    }

    if (this.#preview) this.#drawPreview();

    // Tell the host where the badges are (for comment bubbles), only when something moved.
    const positions = Object.fromEntries(this.#positions);
    const key = JSON.stringify(positions);
    if (key !== this.#sentPositions) {
      this.#sentPositions = key;
      this.#send({ type: "marks", positions });
    }
  }

  #drawOne(a: OverlayAnnotation, box: Box, range: Range | null, state: { draft: boolean; selected: boolean; faded: boolean; orphaned: boolean }): void {
    const group = this.#doc.createElementNS(SVG_NS, "g");
    group.setAttribute("class", ["mark", state.draft ? "draft" : "", state.selected ? "selected" : "", state.faded ? "faded" : "", state.orphaned ? "orphaned" : ""].join(" "));
    group.style.setProperty("--c", a.color);
    if (a.id) {
      group.addEventListener("click", (e) => this.#onMarkClick(e, a.id));
      this.#hoverEvents(group, a.id);
    }

    let badgeAt: Point = { x: box.x, y: box.y };
    const g = a.geometry;
    switch (g.kind) {
      case "Pin":
        badgeAt = fromFraction(g.point, box);
        break;
      case "Element":
        group.append(rect(this.#doc, box, "outline"));
        break;
      case "Highlight": {
        const rects = range ? clientRectsToDocument(this.#doc, range) : [box];
        for (const r of rects) group.append(rect(this.#doc, r, "highlight"));
        if (rects[0]) badgeAt = { x: rects[0].x, y: rects[0].y };
        break;
      }
      case "Rect": {
        const r = normaliseRect(fromFraction(g.from, box), fromFraction(g.to, box));
        group.append(rect(this.#doc, r, "rect"));
        badgeAt = { x: r.x, y: r.y };
        break;
      }
      case "Arrow": {
        const from = fromFraction(g.from, box);
        const to = fromFraction(g.to, box);
        group.append(arrow(this.#doc, from, to));
        badgeAt = from;
        break;
      }
      case "Ink": {
        const points = g.points.map(([x, y, p]) => {
          const pt = fromFraction({ x, y }, box);
          return [pt.x, pt.y, p] as [number, number, number];
        });
        group.append(ink(this.#doc, points, g.size));
        if (points[0]) badgeAt = { x: points[0][0], y: points[0][1] };
        break;
      }
    }
    this.#svg.append(group);

    const badge = this.#doc.createElement("div");
    badge.className = `badge ${g.kind === "Pin" ? "pin" : ""} ${state.draft ? "draft" : ""} ${state.selected ? "selected" : ""} ${state.faded ? "faded" : ""}`;
    badge.style.setProperty("--c", a.color);
    badge.style.left = `${badgeAt.x}px`;
    badge.style.top = `${badgeAt.y}px`;
    badge.textContent = state.draft ? "+" : String(a.label);
    if (state.orphaned) badge.title = "The element this was attached to has changed; shown where it originally was.";
    if (a.id) {
      badge.addEventListener("click", (e) => this.#onMarkClick(e, a.id));
      this.#hoverEvents(badge, a.id);
      this.#positions.set(a.id, { x: round(badgeAt.x), y: round(badgeAt.y) });
    }
    this.#badges.append(badge);
  }

  #hoverEvents(el: Element, id: string): void {
    el.addEventListener("mouseenter", () => this.#send({ type: "hover", id }));
    el.addEventListener("mouseleave", () => this.#send({ type: "hover", id: null }));
  }

  #drawPreview(): void {
    const { tool, points } = this.#preview!;
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return;
    const group = this.#doc.createElementNS(SVG_NS, "g");
    group.setAttribute("class", "mark draft selected");
    group.style.setProperty("--c", this.#color);
    if (tool === "rect") group.append(rect(this.#doc, normaliseRect({ x: first[0], y: first[1] }, { x: last[0], y: last[1] }), "rect"));
    if (tool === "arrow") group.append(arrow(this.#doc, { x: first[0], y: first[1] }, { x: last[0], y: last[1] }));
    if (tool === "ink") group.append(ink(this.#doc, points, INK_SIZE));
    this.#svg.append(group);
  }

  #onMarkClick(event: Event, id: string): void {
    if (this.#tool !== "select") return;
    event.stopPropagation();
    this.#selected = id;
    this.#send({ type: "selected", id });
    this.render();
  }

  #scrollIntoView(id: string): void {
    const annotation = this.#annotations.find((a) => a.id === id);
    if (!annotation) return;
    const box = this.#boxFor(annotation, this.#resolved.get(id));
    const win = this.#doc.defaultView!;
    win.scrollTo({ left: Math.max(0, box.x - 40), top: Math.max(0, box.y - win.innerHeight / 3), behavior: "smooth" });
  }

  /* ---------------------------------------------------------------- tools */

  #listen(): void {
    const win = this.#doc.defaultView!;
    const on = <K extends keyof WindowEventMap>(target: Window | Document | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, capture = true) => {
      target.addEventListener(type, fn as EventListener, capture);
      this.#cleanup.push(() => target.removeEventListener(type, fn as EventListener, capture));
    };

    on(win, "resize", this.render, false);
    // Marks on position:fixed or sticky elements move when the page scrolls.
    on(win, "scroll", this.render, false);
    const observer = new ResizeObserver(this.render);
    observer.observe(this.#doc.documentElement);
    this.#cleanup.push(() => observer.disconnect());
    void this.#doc.fonts?.ready.then(this.render);

    // Pin and element tools: hover outline and click on page elements.
    on(this.#doc, "pointermove", (e) => {
      if ((this.#tool !== "pin" && this.#tool !== "element") || this.#isIgnored(e)) return;
      const el = this.#elementAt(e.clientX, e.clientY);
      if (!el) return;
      const box = documentBox(el);
      Object.assign(this.#hover.style, { display: "block", left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    });
    on(this.#doc, "click", (e) => {
      if ((this.#tool !== "pin" && this.#tool !== "element") || this.#isIgnored(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const el = this.#elementAt(e.clientX, e.clientY);
      if (!el) return;
      const point = { x: e.pageX, y: e.pageY };
      this.#emitDraft(this.#tool === "pin"
        ? { kind: "Pin", anchor: anchorFor(el), geometry: { kind: "Pin", point: toFraction(point, documentBox(el)) } }
        : { kind: "Element", anchor: anchorFor(el), geometry: { kind: "Element" } });
    });

    // Highlight tool: select text normally, and the selection becomes a highlight.
    on(this.#doc, "mouseup", (e) => {
      if (this.#tool !== "highlight" || this.#isIgnored(e)) return;
      const selection = win.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const root = container.nodeType === 1 ? (container as Element) : container.parentElement;
      if (!root) return;
      const anchor = anchorFor(root, range);
      selection.removeAllRanges();
      if (anchor.text) this.#emitDraft({ kind: "Highlight", anchor, geometry: { kind: "Highlight" } });
    }, false);

    // Drawing tools: the surface layer captures the pointer while a drawing tool is active.
    on(this.#surface, "pointerdown", (e) => {
      if (!DRAWING_TOOLS.has(this.#tool) || e.button !== 0) return;
      e.preventDefault();
      this.#surface.setPointerCapture(e.pointerId);
      this.#preview = { tool: this.#tool, points: [[e.pageX, e.pageY, pressure(e)]] };
      this.render();
    }, false);
    on(this.#surface, "pointermove", (e) => {
      if (!this.#preview) return;
      const point: [number, number, number] = [e.pageX, e.pageY, pressure(e)];
      if (this.#preview.tool === "ink") this.#preview.points.push(point);
      else this.#preview.points[1] = point;
      this.render();
    }, false);
    on(this.#surface, "pointerup", () => this.#finishDrawing(), false);
    on(this.#surface, "pointercancel", () => {
      this.#preview = null;
      this.render();
    }, false);

    on(win, "keydown", (e) => {
      if (e.key === "Escape") {
        this.#preview = null;
        this.#draft = null;
        this.render();
      }
    });
  }

  #finishDrawing(): void {
    const preview = this.#preview;
    this.#preview = null;
    if (!preview || preview.points.length < 2) return this.render();

    const points = preview.points.map(([x, y]) => ({ x, y }));
    const bounds = boundsOf(points);
    if (bounds.width < 4 && bounds.height < 4) return this.render(); // a click, not a drawing

    const container = this.#containerFor(bounds);
    const box = documentBox(container);
    const anchor = anchorFor(container);
    const [first, last] = [points[0]!, points[points.length - 1]!];

    if (preview.tool === "ink") {
      this.#emitDraft({
        kind: "Ink",
        anchor,
        geometry: { kind: "Ink", size: INK_SIZE, points: preview.points.map(([x, y, p]) => {
          const f = toFraction({ x, y }, box);
          return [round(f.x), round(f.y), round(p)];
        }) },
      });
    } else {
      const kind = preview.tool === "rect" ? "Rect" : "Arrow";
      this.#emitDraft({ kind, anchor, geometry: { kind, from: toFraction(first, box), to: toFraction(last, box) } });
    }
  }

  #emitDraft(draft: Omit<Draft, "viewportWidth">): void {
    this.#draft = { ...draft, viewportWidth: this.#doc.defaultView?.innerWidth ?? 0 };
    this.#hover.style.display = "none";
    this.#send({ type: "draft", draft: this.#draft });
    this.render();
  }

  /** The page element under a viewport point, looking inside shadow roots and ignoring the overlay itself. */
  #elementAt(clientX: number, clientY: number): Element | null {
    let scope: Document | ShadowRoot = this.#doc;
    let el: Element | null = null;
    for (let depth = 0; depth < 32; depth++) {
      const hit: Element | undefined = scope.elementsFromPoint(clientX, clientY).find((candidate) => candidate !== this.#host && !this.#ignored.includes(candidate));
      if (!hit || hit === el) break;
      el = hit;
      if (!hit.shadowRoot) break;
      scope = hit.shadowRoot;
    }
    return el && el !== this.#doc.documentElement ? el : this.#doc.body;
  }

  /** The smallest element under the drawing that fully contains it, so the drawing moves with that part of the page. */
  #containerFor(bounds: Box): Element {
    const win = this.#doc.defaultView!;
    let el = this.#elementAt(bounds.x + bounds.width / 2 - win.scrollX, bounds.y + bounds.height / 2 - win.scrollY);
    while (el && el !== this.#doc.body && !contains(documentBox(el), bounds)) {
      el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
    }
    return el ?? this.#doc.body ?? this.#doc.documentElement;
  }
}

/* -------------------------------------------------------------------- drawing helpers */

function rect(doc: Document, box: Box, className: string): SVGRectElement {
  const r = doc.createElementNS(SVG_NS, "rect");
  r.setAttribute("class", className);
  r.setAttribute("x", String(box.x));
  r.setAttribute("y", String(box.y));
  r.setAttribute("width", String(Math.max(1, box.width)));
  r.setAttribute("height", String(Math.max(1, box.height)));
  r.setAttribute("rx", className === "highlight" ? "2" : "4");
  return r;
}

function arrow(doc: Document, from: Point, to: Point): SVGGElement {
  const g = doc.createElementNS(SVG_NS, "g");
  const line = doc.createElementNS(SVG_NS, "line");
  line.setAttribute("class", "arrow");
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 14;
  const head = doc.createElementNS(SVG_NS, "polygon");
  head.setAttribute("class", "arrowhead");
  head.setAttribute("points", [
    [to.x, to.y],
    [to.x - size * Math.cos(angle - Math.PI / 7), to.y - size * Math.sin(angle - Math.PI / 7)],
    [to.x - size * Math.cos(angle + Math.PI / 7), to.y - size * Math.sin(angle + Math.PI / 7)],
  ].map((p) => p.join(",")).join(" "));
  g.append(line, head);
  return g;
}

function ink(doc: Document, points: [number, number, number][], size: number): SVGPathElement {
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "ink");
  path.setAttribute("d", svgPath(getStroke(points, { size, thinning: 0.5, smoothing: 0.5, streamline: 0.5, simulatePressure: points.every((p) => p[2] === 0.5) })));
  return path;
}

/** perfect-freehand's outline -> a smooth SVG path (quadratic curves through midpoints). */
export function svgPath(outline: number[][]): string {
  if (outline.length < 2) return "";
  const mid = (a: number[], b: number[]) => [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2];
  let d = `M${outline[0]![0]!.toFixed(1)},${outline[0]![1]!.toFixed(1)} Q`;
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i]!;
    const m = mid(p, outline[(i + 1) % outline.length]!);
    d += `${p[0]!.toFixed(1)},${p[1]!.toFixed(1)} ${m[0]!.toFixed(1)},${m[1]!.toFixed(1)} `;
  }
  return `${d}Z`;
}

function clientRectsToDocument(doc: Document, range: Range): Box[] {
  const win = doc.defaultView!;
  return Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.left + win.scrollX, y: r.top + win.scrollY, width: r.width, height: r.height }));
}

function pressure(e: PointerEvent): number {
  return e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
}

function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// Colours follow the Inklayer theme (packages/ui tokens): --primary for hover, --foreground for drafts and selection.
const STYLES = `
  :host { all: initial; }
  .shapes { position: absolute; top: 0; left: 0; overflow: visible; pointer-events: none; }
  .surface { position: absolute; top: 0; left: 0; pointer-events: none; cursor: crosshair; touch-action: none; }
  .hover { position: absolute; display: none; pointer-events: none; outline: 2px dashed oklch(0.491 0.27 292.581); outline-offset: 1px; background: oklch(0.491 0.27 292.581 / 0.06); border-radius: 2px; }
  .mark { pointer-events: visiblePainted; cursor: pointer; }
  .mark .outline { fill: none; stroke: var(--c); stroke-width: 2; stroke-dasharray: 6 4; }
  .mark .highlight { fill: color-mix(in srgb, var(--c) 35%, transparent); stroke: none; mix-blend-mode: multiply; }
  .mark .rect { fill: color-mix(in srgb, var(--c) 10%, transparent); stroke: var(--c); stroke-width: 2.5; }
  .mark .arrow { stroke: var(--c); stroke-width: 3; stroke-linecap: round; }
  .mark .arrowhead, .mark .ink { fill: var(--c); stroke: none; }
  .mark.selected .rect, .mark.selected .outline, .mark.selected .arrow { stroke-width: 4; }
  .mark.selected { filter: drop-shadow(0 0 3px color-mix(in srgb, var(--c) 70%, transparent)); }
  .mark.faded, .badge.faded { opacity: 0.35; }
  .mark.orphaned .rect, .mark.orphaned .outline { stroke-dasharray: 2 4; }
  .mark.draft { opacity: 0.85; }
  .badge { position: absolute; transform: translate(-50%, -50%); min-width: 22px; height: 22px; padding: 0 6px; box-sizing: border-box;
    border-radius: 11px; background: var(--c); color: #fff; font: 600 12px/22px "Inklayer Outfit", system-ui, -apple-system, sans-serif; text-align: center;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.35), 0 0 0 2px #fff; pointer-events: auto; cursor: pointer; user-select: none; }
  .badge.pin { transform: translate(-50%, -100%); border-bottom-left-radius: 2px; }
  .badge.selected { box-shadow: 0 1px 3px rgb(0 0 0 / 0.35), 0 0 0 3px oklch(0.145 0.008 326); }
  .badge.draft { background: oklch(0.145 0.008 326); }
`;
