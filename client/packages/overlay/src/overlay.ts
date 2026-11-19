import { anchorFor, documentBox, innerOrigin, resolveElement, resolveRange } from "./anchoring";
import { contains, normaliseRect, toFraction } from "./geometry";
import { arrow, badgeAnchor, INK_SIZE, ink, markShapes, rangeBoxes, rect, SVG_NS } from "./shapes";
import { DRAWING_TOOLS, pressure, round, type Stroke, strokeBounds, strokeGeometry } from "./stroke";
import STYLES from "./styles/overlay.css?inline";
import type { AnchorQuality, Box, Draft, HostMessage, OverlayAnnotation, OverlayMessage, Point, Tool } from "./types";

/** How deep to look through nested shadow roots for the element under the pointer. */
const MAX_SHADOW_DEPTH = 32;

interface Resolved {
  key: string;
  element: Element | null;
  range: Range | null;
  quality: AnchorQuality;
}

export interface OverlayOptions {
  /** Elements whose events the tools ignore, such as the extension's own panel. */
  ignoreEventsFrom?: Element[];
  /**
   * Draw inside this element, and take tool input only there, instead of across the whole page. It must be positioned
   * (e.g. `position: relative`) and should clip its content. Annotations and drafts still use document coordinates.
   */
  within?: HTMLElement;
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
  readonly #within: HTMLElement | null;

  #annotations: OverlayAnnotation[] = [];
  #tool: Tool = "select";
  #color = "#f59e0b";
  #selected: string | null = null;
  #draft: Draft | null = null;
  #preview: Stroke | null = null;
  #frame = 0;
  #positions = new Map<string, Point>();
  #sentPositions = "";

  constructor(doc: Document, send: (message: OverlayMessage) => void, options: OverlayOptions = {}) {
    this.#doc = doc;
    this.#send = send;
    this.#ignored = options.ignoreEventsFrom ?? [];
    this.#within = options.within ?? null;

    this.#host = doc.createElement("inklayer-overlay");
    // Just under the top: comment bubbles, the panel (both 2147483647) and live cursors (2147483646) sit above the drawings.
    this.#host.setAttribute(
      "style",
      "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483645;pointer-events:none;",
    );
    const shadow = this.#host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = STYLES;
    shadow.append(style);
    this.#svg = doc.createElementNS(SVG_NS, "svg");
    this.#svg.setAttribute("class", "shapes");
    this.#badges = doc.createElement("div");
    this.#hover = doc.createElement("div");
    this.#hover.className = "hover";
    this.#surface = doc.createElement("div");
    this.#surface.className = "surface";
    shadow.append(this.#svg, this.#badges, this.#hover, this.#surface);
    (this.#within ?? doc.documentElement).append(this.#host);

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
    (this.#within ?? this.#doc.documentElement).append(this.#host);
    return true;
  }

  #isIgnored(event: Event): boolean {
    return this.#ignored.length > 0 && event.composedPath().some((node) => this.#ignored.includes(node as Element));
  }

  /** Whether an element is somewhere the tools work: anywhere, or inside `within`. */
  #inScope(el: Element | null): el is Element {
    return !!el && (!this.#within || this.#within.contains(el));
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
          const text = element
            ? resolveRange(element, annotation.anchor.text)
            : { range: null, quality: "orphaned" as const };
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
    if (this.#within) {
      // Shift the layer so its document coordinates line up inside the element, and let the tools capture only its area.
      const origin = innerOrigin(this.#within);
      this.#host.style.transform = `translate(${-origin.x}px, ${-origin.y}px)`;
      Object.assign(this.#surface.style, {
        left: `${origin.x}px`,
        top: `${origin.y}px`,
        width: `${this.#within.clientWidth}px`,
        height: `${this.#within.clientHeight}px`,
      });
    }
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
      this.#drawOne(
        { id: "", kind, color: this.#color, resolved: false, label: 0, anchor, geometry },
        resolved.element ? documentBox(resolved.element) : anchor.element.box,
        range,
        { draft: true, selected: true, faded: false, orphaned: false },
      );
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

  #drawOne(
    a: OverlayAnnotation,
    box: Box,
    range: Range | null,
    state: { draft: boolean; selected: boolean; faded: boolean; orphaned: boolean },
  ): void {
    const flags = (names: Record<string, boolean>) =>
      Object.entries(names)
        .filter(([, on]) => on)
        .map(([name]) => name);
    const highlightBoxes = range ? rangeBoxes(this.#doc, range) : null;

    const group = this.#doc.createElementNS(SVG_NS, "g");
    group.setAttribute("class", ["mark", ...flags(state)].join(" "));
    group.style.setProperty("--c", a.color);
    group.append(...markShapes(this.#doc, a.geometry, box, highlightBoxes));
    this.#svg.append(group);

    const badgeAt = badgeAnchor(a.geometry, box, highlightBoxes);
    const badge = this.#doc.createElement("div");
    const { orphaned: _orphaned, ...badgeState } = state;
    badge.className = ["badge", ...flags({ pin: a.geometry.kind === "Pin", ...badgeState })].join(" ");
    badge.style.setProperty("--c", a.color);
    badge.style.left = `${badgeAt.x}px`;
    badge.style.top = `${badgeAt.y}px`;
    badge.textContent = state.draft ? "+" : String(a.label);
    if (state.orphaned) badge.title = "The element this was attached to has changed; shown where it originally was.";
    this.#badges.append(badge);

    if (!a.id) return; // the draft isn't clickable
    for (const el of [group, badge]) {
      el.addEventListener("click", (e) => this.#onMarkClick(e, a.id));
      this.#hoverEvents(el, a.id);
    }
    this.#positions.set(a.id, { x: round(badgeAt.x), y: round(badgeAt.y) });
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
    if (tool === "rect")
      group.append(rect(this.#doc, normaliseRect({ x: first[0], y: first[1] }, { x: last[0], y: last[1] }), "rect"));
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

  /** Adds an event listener that's removed again by destroy(). */
  #on<K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement,
    type: K,
    fn: (e: WindowEventMap[K]) => void,
    capture = true,
  ): void {
    target.addEventListener(type, fn as EventListener, capture);
    this.#cleanup.push(() => target.removeEventListener(type, fn as EventListener, capture));
  }

  #listen(): void {
    this.#followLayout();
    this.#listenPicking();
    this.#listenHighlighting();
    this.#listenDrawing();
    this.#on(this.#window, "keydown", (e) => {
      if (e.key !== "Escape") return;
      this.#preview = null;
      this.#draft = null;
      this.render();
    });
  }

  get #window(): Window {
    const win = this.#doc.defaultView;
    if (!win) throw new Error("The overlay's document has no window.");
    return win;
  }

  /** Redraws when the page's layout changes: resizing, scrolling (fixed and sticky elements move), fonts loading. */
  #followLayout(): void {
    this.#on(this.#window, "resize", this.render, false);
    this.#on(this.#window, "scroll", this.render, false);
    const observer = new ResizeObserver(this.render);
    observer.observe(this.#doc.documentElement);
    if (this.#within) observer.observe(this.#within);
    this.#cleanup.push(() => observer.disconnect());
    void this.#doc.fonts?.ready.then(this.render);
  }

  /** Pin and element tools: outline the element under the pointer, and click to comment on it. */
  #listenPicking(): void {
    const picking = (e: Event) => (this.#tool === "pin" || this.#tool === "element") && !this.#isIgnored(e);
    this.#on(this.#doc, "pointermove", (e) => {
      if (!picking(e)) return;
      const el = this.#elementAt(e.clientX, e.clientY);
      if (!this.#inScope(el)) {
        this.#hover.style.display = "none";
        return;
      }
      const box = documentBox(el);
      Object.assign(this.#hover.style, {
        display: "block",
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.width}px`,
        height: `${box.height}px`,
      });
    });
    this.#on(this.#doc, "click", (e) => {
      if (!picking(e)) return;
      const el = this.#elementAt(e.clientX, e.clientY);
      if (!this.#inScope(el)) return;
      e.preventDefault();
      e.stopPropagation();
      const anchor = anchorFor(el);
      if (this.#tool === "element") {
        this.#emitDraft({ kind: "Element", anchor, geometry: { kind: "Element" } });
        return;
      }
      const point = toFraction({ x: e.pageX, y: e.pageY }, documentBox(el));
      this.#emitDraft({ kind: "Pin", anchor, geometry: { kind: "Pin", point } });
    });
  }

  /** Highlight tool: select text normally, and the selection becomes a highlight. */
  #listenHighlighting(): void {
    const onMouseUp = (e: MouseEvent) => {
      if (this.#tool !== "highlight" || this.#isIgnored(e)) return;
      const selection = this.#window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const root = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement;
      if (!this.#inScope(root)) return;
      const anchor = anchorFor(root, range);
      selection.removeAllRanges();
      if (anchor.text) this.#emitDraft({ kind: "Highlight", anchor, geometry: { kind: "Highlight" } });
    };
    this.#on(this.#doc, "mouseup", onMouseUp, false);
  }

  /** Drawing tools: the surface layer captures the pointer while a drawing tool is active. */
  #listenDrawing(): void {
    const surface = this.#surface;
    this.#on(
      surface,
      "pointerdown",
      (e) => {
        if (!DRAWING_TOOLS.has(this.#tool) || e.button !== 0) return;
        e.preventDefault();
        surface.setPointerCapture(e.pointerId);
        this.#preview = { tool: this.#tool, points: [[e.pageX, e.pageY, pressure(e)]] };
        this.render();
      },
      false,
    );
    this.#on(
      surface,
      "pointermove",
      (e) => {
        if (!this.#preview) return;
        const point: [number, number, number] = [e.pageX, e.pageY, pressure(e)];
        // Ink keeps every point; boxes and arrows only need where they started and where the pointer is now.
        if (this.#preview.tool === "ink") this.#preview.points.push(point);
        else this.#preview.points[1] = point;
        this.render();
      },
      false,
    );
    this.#on(surface, "pointerup", () => this.#finishDrawing(), false);
    const cancel = () => {
      this.#preview = null;
      this.render();
    };
    this.#on(surface, "pointercancel", cancel, false);
  }

  #finishDrawing(): void {
    const stroke = this.#preview;
    this.#preview = null;
    const bounds = stroke && strokeBounds(stroke);
    if (!stroke || !bounds) {
      this.render(); // a click, not a drawing
      return;
    }
    const container = this.#containerFor(bounds);
    const geometry = strokeGeometry(stroke, documentBox(container));
    this.#emitDraft({ kind: geometry.kind, anchor: anchorFor(container), geometry });
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
    for (let depth = 0; depth < MAX_SHADOW_DEPTH; depth++) {
      const hit: Element | undefined = scope
        .elementsFromPoint(clientX, clientY)
        .find((candidate) => candidate !== this.#host && !this.#ignored.includes(candidate));
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
    if (this.#within && !this.#inScope(el)) return this.#within;
    while (el && el !== this.#doc.body && el !== this.#within && !contains(documentBox(el), bounds)) {
      el = el.parentElement ?? (el.getRootNode() as ShadowRoot).host ?? null;
    }
    return el ?? this.#within ?? this.#doc.body ?? this.#doc.documentElement;
  }
}
