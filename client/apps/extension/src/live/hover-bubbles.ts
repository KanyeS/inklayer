import { BubbleLayer, type BubblePosition, followColorScheme } from "@inklayer/overlay";
import { type ComponentChild, render } from "preact";
import type { PageAnnotation } from "./context";

/** Unmounts a bubble's content before its card is removed. */
const unmount = (card: HTMLElement) => render(null, card);

/** How long a hover bubble stays after the pointer leaves its mark, so it can move into the bubble. */
const HIDE_BUBBLE_MS = 350;

export interface HoverBubblesSource {
  /** The comments with marks on the page now. */
  visible(): PageAnnotation[];
  /** Marks are showing (bubbles hide with them). */
  marksVisible(): boolean;
  /** Every comment's bubble is open, not just on hover. */
  allOpen(): boolean;
  /** Hovering a mark opens its bubble (only with the select tool, so drawing isn't covered up). */
  hoverOpens(): boolean;
  /** A reply is being written in this comment's bubble, so it mustn't close. */
  keepOpen(id: string): boolean;
  /** A comment's bubble content. */
  content(a: PageAnnotation, pinned: boolean, togglePin: () => void): ComponentChild;
}

/**
 * Which comment bubbles are open next to their marks: those pinned open, the one under the pointer, or all of them.
 * The BubbleLayer places them; this decides which and when.
 */
export class HoverBubbles {
  readonly #layer: BubbleLayer;
  readonly #source: HoverBubblesSource;
  /** The comment whose mark the pointer is on, shown in a bubble until it leaves. */
  #hoverId: string | null = null;
  /** Bubbles kept open with the pin button. */
  readonly #pinned = new Set<string>();
  #inBubble = false;
  /** Which marks have positions; bubbles are rebuilt only when this changes, not on every move. */
  #markIds = "";
  #hideTimer = 0;

  constructor(styles: string, source: HoverBubblesSource) {
    this.#source = source;
    this.#layer = new BubbleLayer(
      styles,
      () => {
        this.#inBubble = true;
        clearTimeout(this.#hideTimer);
      },
      () => {
        this.#inBubble = false;
        this.#scheduleHide();
      },
    );
    followColorScheme(this.#layer.host);
  }

  /** The bubbles' host element on the page. */
  get host(): HTMLElement {
    return this.#layer.host;
  }

  ensureAttached(): void {
    this.#layer.ensureAttached();
  }

  /** The marks moved: move the bubbles with them, and rebuild them if marks appeared or went. */
  setPositions(positions: Record<string, BubblePosition>): void {
    this.#layer.setPositions(positions);
    const ids = Object.keys(positions).sort().join();
    if (ids === this.#markIds) return;
    this.#markIds = ids;
    this.render();
  }

  /** The pointer moved onto a mark (its id) or off it (null). */
  hover(id: string | null): void {
    if (!id) {
      this.#scheduleHide();
      return;
    }
    clearTimeout(this.#hideTimer);
    if (this.#source.hoverOpens() && id !== this.#hoverId) {
      this.#hoverId = id;
      this.render();
    }
  }

  render(): void {
    if (!this.#source.marksVisible()) {
      this.#layer.showEach([], () => undefined, unmount);
      return;
    }
    const visible = new Map(this.#source.visible().map((a) => [a.id, a]));
    const allOpen = this.#source.allOpen();
    const ids = [...visible.keys()].filter((id) => allOpen || this.#pinned.has(id) || id === this.#hoverId);
    this.#layer.showEach(
      ids,
      (id, card) => {
        const a = visible.get(id);
        render(a ? this.#source.content(a, this.#pinned.has(id), () => this.#togglePin(id)) : null, card);
      },
      unmount,
    );
  }

  #togglePin(id: string): void {
    if (this.#pinned.has(id)) this.#pinned.delete(id);
    else this.#pinned.add(id);
    this.render();
  }

  /** Hides the hover bubble shortly after the pointer leaves, unless it moved into the bubble or a reply is being written there. */
  #scheduleHide(): void {
    clearTimeout(this.#hideTimer);
    this.#hideTimer = window.setTimeout(() => {
      const id = this.#hoverId;
      if (!id || this.#inBubble) return;
      if (this.#layer.hasFocus(id) || this.#source.keepOpen(id)) return;
      this.#hoverId = null;
      this.render();
    }, HIDE_BUBBLE_MS);
  }
}
