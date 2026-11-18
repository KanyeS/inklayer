import { anchorFor, resolveElement, resolveRange, scopedSelectorPath } from "./anchoring";
import type { Anchor, ElementAnchor } from "./types";

/**
 * Live presence on a page, drawn the way design tools do it: each person's pointer as an arrow in their colour with a name
 * tag, their text selection tinted in the same colour, and a row of avatars of who is here.
 *
 * Positions travel as anchors, not screen coordinates, so a cursor over a paragraph stays over that paragraph on a
 * screen of a different size: the element under the pointer (its selector path) plus the fractions across its box.
 * If the element can't be found on this page, the document position (relative to the page width) is used instead.
 */

/** Someone else on the page. */
export interface PresencePeerView {
  id: string;
  name: string;
  color: string;
}

/** Where someone's pointer is. */
export interface CursorPosition {
  /** The element under the pointer, by selector path (one selector per shadow scope) and tag. */
  a?: { path: string[]; tag: string };
  /** Fractions across and down that element's box. */
  fx?: number;
  fy?: number;
  /** Fallback: the document position, both as fractions of the page width. */
  dx: number;
  dy: number;
}

const IDLE_AFTER_MS = 10_000;
const MAX_SELECTION_JSON = 12_000;
const SMOOTHING = 0.35;

const pathCache = new WeakMap<Element, string[]>();

/** The pointer's position as an anchor. `ignore` skips Inklayer's own elements. */
export function cursorPositionAt(doc: Document, clientX: number, clientY: number, ignore?: (el: Element) => boolean): CursorPosition {
  const win = doc.defaultView!;
  const width = Math.max(1, doc.documentElement.scrollWidth);
  const position: CursorPosition = { dx: round((clientX + win.scrollX) / width), dy: round((clientY + win.scrollY) / width) };
  const el = doc.elementFromPoint(clientX, clientY);
  if (!el || el === doc.documentElement || ignore?.(el)) return position;

  let path = pathCache.get(el);
  if (!path) {
    path = scopedSelectorPath(el);
    pathCache.set(el, path);
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return position;
  return { ...position, a: { path, tag: el.localName }, fx: round((clientX - rect.left) / rect.width), fy: round((clientY - rect.top) / rect.height) };
}

/** The current selection as an anchor, or null if nothing (or too much) is selected. */
export function selectionAnchor(doc: Document, ignore?: (el: Element) => boolean): Anchor | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const root = container.nodeType === 1 ? (container as Element) : container.parentElement;
  if (!root || ignore?.(root)) return null;
  const anchor = anchorFor(root, range);
  if (!anchor.text) return null;
  return JSON.stringify(anchor).length > MAX_SELECTION_JSON ? null : anchor;
}

interface PeerState {
  peer: PresencePeerView;
  cursor: HTMLDivElement;
  label: HTMLSpanElement;
  selection: HTMLDivElement;
  target: CursorPosition | null;
  /** Where the cursor is drawn, in document coordinates; null until the first move. */
  at: { x: number; y: number } | null;
  /** The resolved target, cached until the page changes. */
  element: Element | null;
  elementKey: string;
  range: Range | null;
  lastMove: number;
  idle: boolean;
}

/** Draws other people's cursors, selections and avatars over the page. Purely visual: it never takes pointer events from the page, except on the avatars. */
export class PresenceLayer {
  readonly #doc: Document;
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  readonly #selections: HTMLDivElement;
  readonly #cursors: HTMLDivElement;
  readonly #avatars: HTMLDivElement;
  readonly #peers = new Map<string, PeerState>();
  #frame = 0;
  #fadeTimer = 0;
  readonly #onViewportChange = () => this.#schedule();
  #status: "connecting" | "live" | "offline" = "connecting";
  #statusText = "";

  constructor(doc: Document) {
    this.#doc = doc;
    this.#host = doc.createElement("inklayer-presence");
    this.#host.setAttribute("style", "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;");
    this.#shadow = this.#host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = STYLES;
    this.#selections = div(doc, "selections");
    this.#cursors = div(doc, "cursors");
    this.#avatars = div(doc, "avatars");
    this.#shadow.append(style, this.#selections, this.#cursors, this.#avatars);
    doc.documentElement.append(this.#host);
    // Positions are kept in document coordinates: redraw when the page scrolls (including inner scrollers) or resizes.
    doc.defaultView!.addEventListener("scroll", this.#onViewportChange, { capture: true, passive: true });
    doc.defaultView!.addEventListener("resize", this.#onViewportChange, { passive: true });
    this.#renderAvatars();
  }

  /** True for Inklayer's own presence elements. */
  owns(el: Element): boolean {
    return el === this.#host;
  }

  /** Puts the layer back if the page replaced the document's children. */
  ensureAttached(): void {
    if (!this.#host.isConnected) this.#doc.documentElement.append(this.#host);
  }

  setStatus(status: "connecting" | "live" | "offline", text = ""): void {
    this.#status = status;
    this.#statusText = text;
    this.#renderAvatars();
  }

  /** Replaces everyone, e.g. after joining a page. */
  setPeers(peers: PresencePeerView[]): void {
    for (const id of [...this.#peers.keys()]) if (!peers.some((p) => p.id === id)) this.removePeer(id);
    for (const peer of peers) this.addPeer(peer);
  }

  addPeer(peer: PresencePeerView): void {
    if (this.#peers.has(peer.id)) return;
    const cursor = div(this.#doc, "cursor");
    cursor.style.setProperty("--c", safeColor(peer.color));
    cursor.innerHTML = ARROW;
    const label = this.#doc.createElement("span");
    label.className = "name";
    label.textContent = peer.name;
    cursor.append(label);
    cursor.hidden = true;
    this.#cursors.append(cursor);
    const selection = div(this.#doc, "selection");
    selection.style.setProperty("--c", safeColor(peer.color));
    this.#selections.append(selection);
    this.#peers.set(peer.id, {
      peer, cursor, label, selection, target: null, at: null, element: null, elementKey: "", range: null, lastMove: 0, idle: true,
    });
    this.#renderAvatars();
  }

  removePeer(id: string): void {
    const state = this.#peers.get(id);
    if (!state) return;
    state.cursor.remove();
    state.selection.remove();
    this.#peers.delete(id);
    this.#renderAvatars();
  }

  moveCursor(id: string, position: CursorPosition): void {
    const state = this.#peers.get(id);
    if (!state || !isCursorPosition(position)) return;
    state.target = position;
    state.lastMove = Date.now();
    state.idle = false;
    this.#schedule();
    // Check again once the cursor has been still long enough to fade.
    const win = this.#doc.defaultView!;
    win.clearTimeout(this.#fadeTimer);
    this.#fadeTimer = win.setTimeout(() => this.#schedule(), IDLE_AFTER_MS + 50);
  }

  setIdle(id: string): void {
    const state = this.#peers.get(id);
    if (state) {
      state.idle = true;
      this.#schedule();
    }
  }

  setSelection(id: string, anchor: Anchor | null): void {
    const state = this.#peers.get(id);
    if (!state) return;
    state.range = null;
    if (anchor && typeof anchor === "object" && anchor.element && anchor.text) {
      const { element } = resolveElement(this.#doc, anchor.element as ElementAnchor);
      if (element) state.range = resolveRange(element, anchor.text).range;
    }
    this.#schedule();
  }

  /** The page's DOM changed: find cursor targets again. */
  reanchor(): void {
    for (const state of this.#peers.values()) state.elementKey = "";
    this.#schedule();
  }

  /** Scrolls so that someone's cursor is in the middle of the screen. */
  scrollTo(id: string): void {
    const at = this.#peers.get(id)?.at;
    const win = this.#doc.defaultView!;
    if (at) win.scrollTo({ left: Math.max(0, at.x - win.innerWidth / 2), top: Math.max(0, at.y - win.innerHeight / 2), behavior: "smooth" });
  }

  destroy(): void {
    const win = this.#doc.defaultView;
    win?.cancelAnimationFrame(this.#frame);
    win?.clearTimeout(this.#fadeTimer);
    win?.removeEventListener("scroll", this.#onViewportChange, { capture: true });
    win?.removeEventListener("resize", this.#onViewportChange);
    this.#host.remove();
    this.#peers.clear();
  }

  /* ------------------------------------------------------------------ drawing */

  #schedule(): void {
    if (!this.#frame) this.#frame = this.#doc.defaultView!.requestAnimationFrame(() => this.#draw());
  }

  #draw(): void {
    this.#frame = 0;
    const win = this.#doc.defaultView!;
    const now = Date.now();
    let moving = false;

    // Read layout for everyone first, then write, so the page is laid out once per frame.
    const frames = [...this.#peers.values()].map((state) => ({
      state,
      target: state.target ? this.#targetOf(state) : null,
      rects: state.range ? Array.from(state.range.getClientRects()).filter((r) => r.width > 0 && r.height > 0) : [],
    }));

    for (const { state, target, rects } of frames) {
      const visible = target !== null && !state.idle && now - state.lastMove < IDLE_AFTER_MS;
      if (target) {
        if (!state.at || Math.hypot(target.x - state.at.x, target.y - state.at.y) > 3000) {
          state.at = { ...target };
        } else {
          state.at.x += (target.x - state.at.x) * SMOOTHING;
          state.at.y += (target.y - state.at.y) * SMOOTHING;
          if (Math.abs(target.x - state.at.x) > 0.5 || Math.abs(target.y - state.at.y) > 0.5) moving = true;
          else state.at = { ...target };
        }
        state.cursor.hidden = false;
        state.cursor.style.transform = `translate(${state.at.x - win.scrollX}px, ${state.at.y - win.scrollY}px)`;
      } else {
        state.cursor.hidden = true;
      }
      state.cursor.classList.toggle("faded", !visible);

      state.selection.replaceChildren(...rects.map((r, i) => {
        const box = div(this.#doc, "mark");
        box.style.transform = `translate(${r.left}px, ${r.top}px)`;
        box.style.width = `${r.width}px`;
        box.style.height = `${r.height}px`;
        if (i === 0) {
          const flag = this.#doc.createElement("span");
          flag.className = "flag";
          flag.textContent = state.peer.name;
          box.append(flag);
        }
        return box;
      }));
    }

    if (moving) this.#schedule();
  }

  /** The cursor target in document coordinates. The element is looked up again only when the path changes or it left the page. */
  #targetOf(state: PeerState): { x: number; y: number } {
    const target = state.target!;
    const key = target.a ? target.a.path.join("\u0000") : "";
    if (key !== state.elementKey || (state.element && !state.element.isConnected)) {
      state.elementKey = key;
      state.element = target.a ? findCursorElement(this.#doc, target) : null;
    }
    return placeCursor(this.#doc, target, state.element);
  }

  #renderAvatars(): void {
    const doc = this.#doc;
    const pill = div(doc, `pill ${this.#status}`);
    const dot = div(doc, "dot");
    const status = doc.createElement("span");
    status.className = "status";
    const others = [...this.#peers.values()];
    status.textContent = this.#status === "live"
      ? others.length === 0 ? "Live · just you" : "Live"
      : this.#status === "connecting" ? "Connecting…" : this.#statusText || "Offline";
    pill.append(dot, status);

    const shown = others.slice(0, 5);
    const faces = div(doc, "faces");
    for (const { peer } of shown) {
      const face = doc.createElement("button");
      face.className = "face";
      face.type = "button";
      face.title = `${peer.name}: show their cursor`;
      face.style.setProperty("--c", safeColor(peer.color));
      face.textContent = initials(peer.name);
      face.addEventListener("click", () => this.scrollTo(peer.id));
      faces.append(face);
    }
    if (others.length > shown.length) {
      const more = div(doc, "face more");
      more.textContent = `+${others.length - shown.length}`;
      more.title = others.slice(shown.length).map((p) => p.peer.name).join(", ");
      faces.append(more);
    }
    if (shown.length > 0) pill.append(faces);
    this.#avatars.replaceChildren(pill);
  }
}

/** The element a cursor position refers to on this page, or null if it isn't here. */
export function findCursorElement(doc: Document, position: CursorPosition): Element | null {
  if (!position.a) return null;
  const anchor: ElementAnchor = { path: position.a.path, xpath: null, tag: position.a.tag, text: "", box: { x: 0, y: 0, width: 0, height: 0 } };
  return resolveElement(doc, anchor).element;
}

/**
 * Where to draw a cursor, in document coordinates: at the same fractions of the same element's box, or, if the element
 * isn't on this page (or has no size), at the same document position relative to the page width.
 */
export function placeCursor(doc: Document, position: CursorPosition, element: Element | null = findCursorElement(doc, position)): { x: number; y: number } {
  const win = doc.defaultView!;
  if (element && position.fx !== undefined && position.fy !== undefined) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return { x: rect.left + position.fx * rect.width + win.scrollX, y: rect.top + position.fy * rect.height + win.scrollY };
    }
  }
  const width = Math.max(1, doc.documentElement.scrollWidth);
  return { x: position.dx * width, y: position.dy * width };
}

function isCursorPosition(value: unknown): value is CursorPosition {
  const p = value as CursorPosition | null;
  return !!p && typeof p === "object" && Number.isFinite(p.dx) && Number.isFinite(p.dy)
    && (p.a === undefined || (Array.isArray(p.a.path) && p.a.path.every((s) => typeof s === "string") && typeof p.a.tag === "string"
      && Number.isFinite(p.fx) && Number.isFinite(p.fy)));
}

/** Only #rrggbb colours reach the style attribute. */
function safeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#7c3aed";
}

export function initials(name: string): string {
  const words = name.trim().split("@")[0]!.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function div(doc: Document, className: string): HTMLDivElement {
  const el = doc.createElement("div");
  el.className = className;
  return el;
}

/** The pointer arrow, filled with the person's colour and outlined in white. */
const ARROW = `<svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true"><path d="M2.5 1.8 L2.5 17.6 L6.6 13.7 L9.4 20.1 L12.4 18.8 L9.6 12.5 L15.4 12.5 Z" fill="var(--c)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

const STYLES = `
:host { all: initial; }
.cursors, .selections { position: fixed; inset: 0; overflow: hidden; pointer-events: none; }
.cursor { position: absolute; left: 0; top: 0; will-change: transform; transition: opacity .3s ease; filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / .3)); }
.cursor[hidden] { display: none; }
.cursor.faded { opacity: 0; }
.cursor svg { display: block; }
.name {
  position: absolute; left: 14px; top: 18px; white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis;
  background: var(--c); color: #fff; border-radius: 3px 9px 9px 9px; padding: 3px 8px;
  font: 600 11.5px/1.25 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; letter-spacing: .01em;
}
.mark { position: absolute; left: 0; top: 0; background: color-mix(in srgb, var(--c) 24%, transparent); border-radius: 2px; }
.mark:first-child { box-shadow: -2px 0 0 0 var(--c); }
.flag {
  position: absolute; left: -2px; bottom: 100%; white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis;
  background: var(--c); color: #fff; border-radius: 3px 3px 3px 0; padding: 1px 6px;
  font: 600 10.5px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.avatars { position: fixed; top: 12px; right: 12px; pointer-events: none; }
.pill {
  pointer-events: auto; display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 10px; min-height: 28px; box-sizing: border-box;
  background: #fff; color: #1f2328; border-radius: 999px; box-shadow: 0 1px 3px rgb(0 0 0 / .12), 0 4px 14px rgb(0 0 0 / .1);
  font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.pill:not(:has(.faces)) { padding-right: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #0acf83; box-shadow: 0 0 0 3px rgb(10 207 131 / .2); }
.connecting .dot { background: #e8a100; box-shadow: 0 0 0 3px rgb(232 161 0 / .2); }
.offline .dot { background: #9ca3af; box-shadow: none; }
.faces { display: flex; flex-direction: row-reverse; }
.face {
  all: unset; box-sizing: border-box; width: 26px; height: 26px; margin-left: -6px; border-radius: 50%; cursor: pointer;
  display: grid; place-items: center; background: var(--c, #6b7280); color: #fff; border: 2px solid #fff;
  font: 700 10px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; transition: transform .12s ease;
}
.face:hover, .face:focus-visible { transform: translateY(-2px); z-index: 1; outline: none; }
.face.more { cursor: default; background: #e5e7eb; color: #374151; }
@media (prefers-color-scheme: dark) {
  .pill { background: #1f2328; color: #f3f4f6; }
  .face { border-color: #1f2328; }
  .face.more { background: #374151; color: #e5e7eb; }
}
`;
