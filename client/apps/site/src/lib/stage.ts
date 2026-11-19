/**
 * A stage is one mock page on the showcase, with the extension's real layers drawn inside it:
 * - marks (pins, outlines, highlights, boxes, arrows, ink) by Overlay, with the real drawing tools;
 * - live cursors and selections by PresenceLayer;
 * - comment cards beside the marks by BubbleLayer.
 * All three come from @inklayer/overlay, scoped to the stage with their `within` option. Comments are kept here, in
 * memory: nothing is saved anywhere.
 */
import {
  BubbleLayer, Overlay, PresenceLayer, anchorFor, documentBox,
  type AnchorQuality, type Anchor, type AnnotationKind, type Draft, type Geometry, type OverlayAnnotation, type OverlayMessage, type Point, type Tool,
} from "@inklayer/overlay";
import tokens from "@inklayer/ui/tokens.css?inline";
import { followColorScheme, h, textRange } from "./dom";
import { YOU, type Person } from "./people";
import { type Ctx, pauseScenes } from "./scene";

/** What a comment points at: the same shape the extension saves. */
export interface Mark {
  kind: AnnotationKind;
  anchor: Anchor;
  geometry: Geometry;
}

export interface Reply {
  person: Person;
  body: string;
  time: string;
}

export interface Comment extends Mark {
  id: string;
  label: number;
  person: Person;
  body: string;
  time: string;
  resolved: boolean;
  replies: Reply[];
  /** Still being drawn or written: shown as a mark, but without a card. */
  draft: boolean;
}

/* ------------------------------------------------------------------ marks */

/** Marks built the way the extension builds them: anchors from the real anchoring code, shapes as fractions of the element. */
export const marks = {
  /** A pin at a point on the element, as fractions of its box. */
  pin: (el: Element, x = 0.5, y = 0.5): Mark => ({ kind: "Pin", anchor: anchorFor(el), geometry: { kind: "Pin", point: { x, y } } }),
  /** The whole element, outlined. */
  element: (el: Element): Mark => ({ kind: "Element", anchor: anchorFor(el), geometry: { kind: "Element" } }),
  /** A phrase inside the element, highlighted. */
  highlight: (el: Element, phrase: string): Mark => ({ kind: "Highlight", anchor: anchorFor(el, textRange(el, phrase)), geometry: { kind: "Highlight" } }),
  rect: (el: Element, from: Point, to: Point): Mark => ({ kind: "Rect", anchor: anchorFor(el), geometry: { kind: "Rect", from, to } }),
  arrow: (el: Element, from: Point, to: Point): Mark => ({ kind: "Arrow", anchor: anchorFor(el), geometry: { kind: "Arrow", from, to } }),
  /** Freehand ink through points given as fractions of the element. */
  ink: (el: Element, points: Point[]): Mark => ({
    kind: "Ink", anchor: anchorFor(el), geometry: { kind: "Ink", size: 6, points: points.map((p) => [p.x, p.y, 0.5]) },
  }),
};

/* ------------------------------------------------------------------ stage */

export interface StageOptions {
  /** Every comment's card open beside its mark (the panel's "open all" button), rather than only on hover or when pinned. */
  cardsOpen?: boolean;
  /** Show the "Live" pill with everyone's faces. */
  avatars?: boolean;
  /** Called when the visitor finishes drawing with a tool (see `setTool`). */
  onDraft?: (draft: Draft) => void;
  /** Called when a mark is clicked with the Select tool. */
  onSelect?: (id: string | null) => void;
  /** Called after the overlay re-finds every mark's element. */
  onAnchors?: (quality: Record<string, AnchorQuality>) => void;
}

const allStages = new Set<Stage>();
let peopleVisible = true;

/**
 * The "Demo people" switch: pauses the pretend team and hides their cursors, marks and cards everywhere (and their entries
 * in the mock panels, via the `no-demo-people` class), so a visitor sees only their own comments and their extension's.
 */
export function setDemoPeopleVisible(visible: boolean): void {
  peopleVisible = visible;
  pauseScenes(!visible);
  document.documentElement.classList.toggle("no-demo-people", !visible);
  for (const stage of allStages) stage.sync();
  for (const listener of switchListeners) listener(visible);
}

const switchListeners = new Set<(visible: boolean) => void>();

/** Calls `listener` now and whenever the "Demo people" switch changes (for demo people drawn outside a stage). */
export function onDemoPeopleSwitch(listener: (visible: boolean) => void): void {
  switchListeners.add(listener);
  listener(peopleVisible);
}

/** Whether a comment shows: the visitor's own always do; the pretend team's only while the switch is on. */
const isShown = (c: Comment) => peopleVisible || c.person.id === YOU.id;

let nextId = 1;

export class Stage {
  readonly overlay: Overlay;
  readonly presence: PresenceLayer;
  readonly cards: BubbleLayer;
  comments: Comment[] = [];
  cardsOpen: boolean;
  readonly #pinned = new Set<string>();
  #hovered: string | null = null;
  #hideTimer = 0;
  #inCard = false;
  #selected: string | null = null;

  constructor(readonly root: HTMLElement, readonly options: StageOptions = {}) {
    this.cardsOpen = options.cardsOpen ?? false;
    root.classList.add("stage-root");
    this.overlay = new Overlay(document, (message) => this.#onOverlay(message), { within: root });
    this.presence = new PresenceLayer(document, { within: root, avatars: options.avatars ?? false });
    this.presence.setStatus("live");
    this.cards = new BubbleLayer(CARD_STYLES, () => {
      this.#inCard = true;
      clearTimeout(this.#hideTimer);
    }, () => {
      this.#inCard = false;
      this.#hideSoon();
    }, { within: root });
    followColorScheme(this.cards.host);
    this.#followPageChanges();
    allStages.add(this);
    this.presence.setVisible(peopleVisible);
  }

  /** Someone on this page: adds their cursor (hidden until it first moves). */
  person(person: Person): Cursor {
    return new Cursor(this, person);
  }

  /** Adds a comment on a mark and returns it. `draft` comments show their mark but no card yet. */
  add(person: Person, mark: Mark, body = "", extra: Partial<Comment> = {}): Comment {
    const comment: Comment = {
      id: `c${nextId++}`, label: this.comments.length + 1, person, body, time: "just now", resolved: false, replies: [], draft: false,
      ...mark, ...extra,
    };
    this.comments.push(comment);
    this.sync();
    return comment;
  }

  /** Changes a comment (its shape while it's being drawn, its text, replies, resolved…) and redraws. */
  update(comment: Comment, changes: Partial<Comment>): void {
    Object.assign(comment, changes);
    this.sync();
  }

  clear(): void {
    this.comments = [];
    this.#pinned.clear();
    this.#hovered = null;
    this.#selected = null;
    this.overlay.handle({ type: "clearDraft" });
    this.overlay.handle({ type: "select", id: null, scroll: false });
    this.sync();
  }

  /** Selects a comment's mark (as clicking it in the panel does). */
  select(id: string | null): void {
    this.#selected = id;
    this.overlay.handle({ type: "select", id, scroll: false });
  }

  get selected(): string | null {
    return this.#selected;
  }

  /** Keeps a comment's card open (the pin button on the card). */
  pinCard(id: string, pinned = true): void {
    if (pinned) this.#pinned.add(id);
    else this.#pinned.delete(id);
    this.#renderCards();
  }

  setCardsOpen(open: boolean): void {
    this.cardsOpen = open;
    this.#renderCards();
  }

  /** Switches the overlay's tool, as the panel's tool buttons do. Drawing then reports drafts to `onDraft`. */
  setTool(tool: Tool, color: string): void {
    this.overlay.handle({ type: "setTool", tool, color });
  }

  clearDraft(): void {
    this.overlay.handle({ type: "clearDraft" });
  }

  /** Hands the comments to the overlay and redraws the cards. */
  sync(): void {
    this.presence.setVisible(peopleVisible);
    const annotations: OverlayAnnotation[] = this.comments.filter(isShown).map((c) => ({
      id: c.id, kind: c.kind, color: c.person.color, resolved: c.resolved, label: c.label, anchor: c.anchor, geometry: c.geometry,
    }));
    this.overlay.handle({ type: "setAnnotations", annotations });
    if (this.#selected) this.overlay.handle({ type: "select", id: this.#selected, scroll: false });
    this.#renderCards();
  }

  /* ---------------------------------------------------------------- overlay events */

  #onOverlay(message: OverlayMessage): void {
    switch (message.type) {
      case "marks":
        this.cards.setPositions(message.positions);
        break;
      case "hover":
        clearTimeout(this.#hideTimer);
        if (message.id) {
          this.#hovered = message.id;
          this.#renderCards();
        } else this.#hideSoon();
        break;
      case "selected":
        this.#selected = message.id;
        this.options.onSelect?.(message.id);
        break;
      case "draft":
        this.options.onDraft?.(message.draft);
        break;
      case "anchors":
        this.options.onAnchors?.(message.quality);
        break;
    }
  }

  /** Like the extension: the hovered card stays a moment after the pointer leaves, and while the pointer is on it. */
  #hideSoon(): void {
    clearTimeout(this.#hideTimer);
    this.#hideTimer = window.setTimeout(() => {
      if (this.#inCard) return;
      this.#hovered = null;
      this.#renderCards();
    }, 350);
  }

  /** The page changed: find marks and cursors' elements again, and keep redrawing while CSS transitions run. */
  #followPageChanges(): void {
    let pending = 0;
    new MutationObserver(() => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        this.overlay.reanchor();
        this.presence.reanchor();
      });
    }).observe(this.root, { childList: true, subtree: true, characterData: true });

    let running = 0;
    const redraw = () => {
      this.overlay.render();
      if (running > 0) requestAnimationFrame(redraw);
    };
    this.root.addEventListener("transitionrun", () => {
      if (running++ === 0) requestAnimationFrame(redraw);
    });
    const ended = () => {
      running = Math.max(0, running - 1);
      this.overlay.render();
    };
    this.root.addEventListener("transitionend", ended);
    this.root.addEventListener("transitioncancel", ended);
  }

  /* ---------------------------------------------------------------- comment cards */

  #renderCards(): void {
    const shown = this.comments.filter((c) => isShown(c) && !c.draft && (this.cardsOpen || this.#pinned.has(c.id) || c.id === this.#hovered));
    this.cards.show(shown.map((c) => c.id), (id) => this.#card(this.comments.find((c) => c.id === id)!));
  }

  /** A card's content, laid out like the extension's: author and time, the comment, then replies. */
  #card(c: Comment): Node[] {
    const pinned = this.#pinned.has(c.id);
    const pin = h("button", {
      className: pinned ? "pin-toggle on" : "pin-toggle",
      title: pinned ? "Unpin: show only on hover" : "Pin: keep this open",
      onclick: () => this.pinCard(c.id, !pinned),
    });
    pin.innerHTML = PIN_ICON;
    const nodes: Node[] = [
      h("div", { className: "bubble-head" },
        h("span", { className: "dot", style: { background: c.person.color } }),
        h("strong", { textContent: c.person.name, title: c.person.role }),
        h("span", { className: "muted", textContent: c.time }),
        c.resolved && h("span", { className: "muted", textContent: "· resolved" }),
        h("span", { className: "grow" }),
        pin),
      h("p", { className: "body", textContent: c.body || "…" }),
    ];
    if (c.replies.length) {
      nodes.push(h("ul", { className: "replies" }, ...c.replies.map((r) =>
        h("li", { className: "reply" },
          h("div", { className: "meta" }, h("strong", { textContent: r.person.name }), h("span", { className: "muted", textContent: ` ${r.time}` })),
          h("span", { textContent: r.body })))));
    }
    return nodes;
  }
}

/* ------------------------------------------------------------------ cursors */

/** Where to move a cursor: a spot on an element (fractions of its box), or any document point. */
export type Target = { el: Element; x?: number; y?: number } | (() => Point);

/** One pretend person's pointer and text selection on a stage, drawn by the real PresenceLayer. */
export class Cursor {
  #at: Point | null = null;

  constructor(readonly stage: Stage, readonly person: Person) {
    stage.presence.addPeer({ id: person.id, name: person.name, color: person.color, fullName: `${person.name} · ${person.role}` });
  }

  /** The target's position in document coordinates, worked out now (elements move). */
  static point(target: Target): Point {
    if (typeof target === "function") return target();
    const box = documentBox(target.el);
    return { x: box.x + box.width * (target.x ?? 0.5), y: box.y + box.height * (target.y ?? 0.5) };
  }

  place(point: Point): void {
    this.#at = point;
    this.stage.presence.placeAt(this.person.id, point);
  }

  /** Glides to the target over `ms`, on a slight curve like a hand on a mouse. Appears there first if it hasn't moved yet. */
  async moveTo(ctx: Ctx, target: Target, ms = 900): Promise<void> {
    const from = this.#at;
    if (!from) {
      this.place(Cursor.point(target));
      return ctx.sleep(ms / 3);
    }
    const bend = (Math.random() - 0.5) * 0.36;
    await ctx.animate(ms, (t) => {
      const to = Cursor.point(target);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const curve = Math.sin(Math.PI * t) * bend;
      this.place({ x: from.x + dx * t - dy * curve, y: from.y + dy * t + dx * curve });
    });
  }

  /** Drags across text to select `phrase` inside `el`; the selection shows in the person's colour with their name. */
  async select(ctx: Ctx, el: Element, phrase: string, ms = 900): Promise<void> {
    const full = textRange(el, phrase);
    const range = full.cloneRange();
    range.collapse(true);
    await this.moveTo(ctx, () => rangeEdge(full, "start"));
    await ctx.animate(ms, (t) => {
      range.setEnd(full.startContainer, full.startOffset + Math.round((full.endOffset - full.startOffset) * t));
      if (!range.collapsed) this.stage.presence.setSelection(this.person.id, anchorFor(el, range));
      this.place(rangeEdge(range, "end"));
    }, true);
  }

  clearSelection(): void {
    this.stage.presence.setSelection(this.person.id, null);
  }

  /** Drags from one point of `el` to another, calling `drawTo` with the current point as fractions of el's box. */
  async drag(ctx: Ctx, el: Element, from: Point, to: Point, drawTo: (p: Point) => void, ms = 800): Promise<void> {
    await this.moveTo(ctx, { el, x: from.x, y: from.y });
    await ctx.animate(ms, (t) => {
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      drawTo(p);
      this.place(Cursor.point({ el, ...p }));
    });
  }

  /** Draws through `points` (fractions of el's box), calling `drawTo` with the points so far. */
  async trace(ctx: Ctx, el: Element, points: Point[], drawTo: (soFar: Point[]) => void, ms = 1100): Promise<void> {
    await this.moveTo(ctx, { el, ...points[0]! });
    await ctx.animate(ms, (t) => {
      const upTo = Math.max(1, Math.round(t * (points.length - 1)));
      drawTo(points.slice(0, upTo + 1));
      this.place(Cursor.point({ el, ...points[upTo]! }));
    }, true);
  }

  /** Lets go of the mouse: after ten seconds without moving, the real layer fades the cursor. Here, at once. */
  hide(): void {
    this.#at = null;
    this.stage.presence.placeAt(this.person.id, null);
  }
}

/** The start or end of a range, in document coordinates (a little below the top of the line, where a pointer would be). */
function rangeEdge(range: Range, edge: "start" | "end"): Point {
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
  const r = (edge === "start" ? rects[0] : rects[rects.length - 1]) ?? range.getBoundingClientRect();
  return { x: (edge === "start" ? r.left : r.right) + scrollX, y: r.top + r.height * 0.65 + scrollY };
}

/* ------------------------------------------------------------------ card styles */

const PIN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;

/** The theme's tokens inside the cards' shadow root (as the extension's panel does), plus the few classes the cards use. */
const CARD_STYLES = `${tokens.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:root/g, ":host").replace(/\.dark\b/g, ":host(.dark)")}
  :host { all: initial; }
  .muted { color: var(--muted-foreground); font-size: 12px; }
  .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .meta { color: var(--muted-foreground); }
  .meta strong { color: var(--foreground); }
`;
