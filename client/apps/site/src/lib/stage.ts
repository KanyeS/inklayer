/**
 * A stage is one mock page on the showcase, with the extension's real layers drawn inside it:
 * - marks (pins, outlines, highlights, boxes, arrows, ink) by Overlay, with the real drawing tools;
 * - live cursors and selections by PresenceLayer;
 * - comment cards beside the marks by BubbleLayer.
 * All three come from @inklayer/overlay, scoped to the stage with their `within` option. Comments are kept here, in
 * memory: nothing is saved anywhere. The marks, cursors and cards are built in marks.ts, cursor.ts and cards.ts.
 */
import {
  type AnchorQuality,
  BubbleLayer,
  type Draft,
  followColorScheme,
  Overlay,
  type OverlayAnnotation,
  type OverlayMessage,
  PresenceLayer,
  type Tool,
} from "@inklayer/overlay";
import { CARD_STYLES, commentCard } from "./cards";
import { Cursor } from "./cursor";
import type { Comment, Mark } from "./marks";
import { type Person, YOU } from "./people";
import { pauseScenes } from "./scene";

export { Cursor, type Target } from "./cursor";
export { type Comment, type Mark, marks, type Reply } from "./marks";

/** Like the extension: the hovered card stays this long after the pointer leaves. */
const HIDE_CARD_MS = 350;

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

  constructor(
    readonly root: HTMLElement,
    readonly options: StageOptions = {},
  ) {
    this.cardsOpen = options.cardsOpen ?? false;
    root.classList.add("stage-root");
    this.overlay = new Overlay(document, (message) => this.#onOverlay(message), { within: root });
    this.presence = new PresenceLayer(document, { within: root, avatars: options.avatars ?? false });
    this.presence.setStatus("live");
    this.cards = new BubbleLayer(
      CARD_STYLES,
      () => {
        this.#inCard = true;
        clearTimeout(this.#hideTimer);
      },
      () => {
        this.#inCard = false;
        this.#hideSoon();
      },
      { within: root },
    );
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
      id: `c${nextId++}`,
      label: this.comments.length + 1,
      person,
      body,
      time: "just now",
      resolved: false,
      replies: [],
      draft: false,
      ...mark,
      ...extra,
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
      id: c.id,
      kind: c.kind,
      color: c.person.color,
      resolved: c.resolved,
      label: c.label,
      anchor: c.anchor,
      geometry: c.geometry,
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
    }, HIDE_CARD_MS);
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
    const shown = this.comments.filter(
      (c) => isShown(c) && !c.draft && (this.cardsOpen || this.#pinned.has(c.id) || c.id === this.#hovered),
    );
    this.cards.show(
      shown.map((c) => c.id),
      (id) => {
        const c = this.comments.find((x) => x.id === id);
        return c ? commentCard(c, this.#pinned.has(id), (pinned) => this.pinCard(id, pinned)) : [];
      },
    );
  }
}
