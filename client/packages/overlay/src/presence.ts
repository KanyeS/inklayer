import { innerOrigin, resolveElement, resolveRange } from "./anchoring";
import {
  type CursorPosition,
  type DocPoint,
  elementKeyOf,
  findCursorElement,
  glide,
  isCursorPosition,
  placeCursor,
} from "./cursors";
import { avatarPill, cursorElement, type PresencePeerView, type PresenceStatus, safeColor } from "./people";
import STYLES from "./styles/presence.css?inline";
import type { Anchor, ElementAnchor } from "./types";

/**
 * Live presence on a page, drawn the way design tools do it: each person's pointer as an arrow in their colour with a name
 * tag, their text selection tinted in the same colour, and a row of avatars of who is here. Positions arrive as anchors
 * (cursors.ts); how people look is in people.ts.
 */

/** A cursor that hasn't moved for this long fades out. */
const IDLE_AFTER_MS = 10_000;

function div(doc: Document, className: string): HTMLDivElement {
  const el = doc.createElement("div");
  el.className = className;
  return el;
}

interface PeerState {
  peer: PresencePeerView;
  cursor: HTMLDivElement;
  label: HTMLSpanElement;
  selection: HTMLDivElement;
  target: CursorPosition | null;
  /** A position given directly, in document coordinates (see placeAt); wins over target. */
  point: DocPoint | null;
  /** Where the cursor is drawn, in document coordinates; null until the first move. */
  at: DocPoint | null;
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
  readonly #within: HTMLElement | null;
  #frame = 0;
  #fadeTimer = 0;
  readonly #onViewportChange = () => this.#schedule();
  #status: PresenceStatus = "connecting";
  #statusText = "";

  /**
   * With `within`, cursors, selections and the avatars are drawn inside that element (which must be positioned) and
   * clipped to it, instead of over the whole window. Positions are still document coordinates.
   * `avatars: false` leaves out the row of faces, for small areas where cursors are enough.
   */
  constructor(doc: Document, options: { within?: HTMLElement; avatars?: boolean } = {}) {
    this.#doc = doc;
    this.#within = options.within ?? null;
    this.#host = doc.createElement("inklayer-presence");
    this.#host.setAttribute(
      "style",
      this.#within
        ? "all:initial;position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:2147483646;"
        : "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483646;",
    );
    if (this.#within) this.#host.classList.add("within");
    this.#shadow = this.#host.attachShadow({ mode: "closed" });
    const style = doc.createElement("style");
    style.textContent = STYLES;
    this.#selections = div(doc, "selections");
    this.#cursors = div(doc, "cursors");
    this.#avatars = div(doc, "avatars");
    this.#shadow.append(style, this.#selections, this.#cursors);
    if (options.avatars !== false) this.#shadow.append(this.#avatars);
    (this.#within ?? doc.documentElement).append(this.#host);
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
    if (!this.#host.isConnected) (this.#within ?? this.#doc.documentElement).append(this.#host);
  }

  /** Shows or hides everyone's cursors, selections and the avatars, without forgetting them. */
  setVisible(visible: boolean): void {
    this.#host.style.display = visible ? "" : "none";
  }

  setStatus(status: PresenceStatus, text = ""): void {
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
    const { cursor, label } = cursorElement(this.#doc, peer);
    this.#cursors.append(cursor);
    const selection = div(this.#doc, "selection");
    selection.style.setProperty("--c", safeColor(peer.color));
    this.#selections.append(selection);
    this.#peers.set(peer.id, {
      peer,
      cursor,
      label,
      selection,
      target: null,
      point: null,
      at: null,
      element: null,
      elementKey: "",
      range: null,
      lastMove: 0,
      idle: true,
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
    this.#touch(state);
    this.#schedule();
  }

  #touch(state: PeerState): void {
    state.lastMove = Date.now();
    state.idle = false;
    // Check again once the cursor has been still long enough to fade.
    const win = this.#doc.defaultView!;
    win.clearTimeout(this.#fadeTimer);
    this.#fadeTimer = win.setTimeout(() => this.#schedule(), IDLE_AFTER_MS + 50);
  }

  /**
   * Puts someone's cursor at a point in document coordinates, for pages that know where people are themselves (such as
   * the docs editor, which positions by text). Null hides it.
   */
  placeAt(id: string, point: { x: number; y: number } | null): void {
    const state = this.#peers.get(id);
    if (!state) return;
    const moved = point !== null && (!state.point || state.point.x !== point.x || state.point.y !== point.y);
    state.point = point;
    if (point === null) state.idle = true;
    else if (moved) this.#touch(state);
    this.#schedule();
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
    if (at)
      win.scrollTo({
        left: Math.max(0, at.x - win.innerWidth / 2),
        top: Math.max(0, at.y - win.innerHeight / 2),
        behavior: "smooth",
      });
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
    // Where the layer's (0, 0) is: the window's top-left in document coordinates, or the `within` element's.
    const origin = this.#within ? innerOrigin(this.#within) : { x: win.scrollX, y: win.scrollY };
    const viewport = this.#within ? { x: origin.x - win.scrollX, y: origin.y - win.scrollY } : { x: 0, y: 0 };

    // Read layout for everyone first, then write, so the page is laid out once per frame.
    const frames = [...this.#peers.values()].map((state) => ({
      state,
      target: state.point ?? this.#targetOf(state),
      rects: state.range ? Array.from(state.range.getClientRects()).filter((r) => r.width > 0 && r.height > 0) : [],
    }));

    for (const { state, target, rects } of frames) {
      const visible = target !== null && !state.idle && now - state.lastMove < IDLE_AFTER_MS;
      if (target) {
        const step = glide(state.at, target);
        state.at = step.at;
        if (step.moving) moving = true;
        state.cursor.hidden = false;
        state.cursor.style.transform = `translate(${state.at.x - origin.x}px, ${state.at.y - origin.y}px)`;
      } else {
        state.cursor.hidden = true;
      }
      state.cursor.classList.toggle("faded", !visible);

      state.selection.replaceChildren(...this.#selectionMarks(state.peer.name, rects, viewport));
    }

    if (moving) this.#schedule();
  }

  /** Tints for each line of someone's selection, the first with their name on a flag. */
  #selectionMarks(name: string, rects: DOMRect[], viewport: DocPoint): HTMLDivElement[] {
    return rects.map((r, i) => {
      const box = div(this.#doc, "mark");
      box.style.transform = `translate(${r.left - viewport.x}px, ${r.top - viewport.y}px)`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;
      if (i === 0) {
        const flag = this.#doc.createElement("span");
        flag.className = "flag";
        flag.textContent = name;
        box.append(flag);
      }
      return box;
    });
  }

  /** The cursor target in document coordinates. The element is looked up again only when the path changes or it left the page. */
  #targetOf(state: PeerState): DocPoint | null {
    const target = state.target;
    if (!target) return null;
    const key = elementKeyOf(target);
    if (key !== state.elementKey || (state.element && !state.element.isConnected)) {
      state.elementKey = key;
      state.element = target.a ? findCursorElement(this.#doc, target) : null;
    }
    return placeCursor(this.#doc, target, state.element);
  }

  #renderAvatars(): void {
    const peers = [...this.#peers.values()].map((p) => p.peer);
    const pill = avatarPill(this.#doc, { status: this.#status, text: this.#statusText }, peers, (peer) =>
      this.scrollTo(peer.id),
    );
    this.#avatars.replaceChildren(pill);
  }
}
