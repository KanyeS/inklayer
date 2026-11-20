/**
 * Comment bubbles next to marks on the page: a card beside each mark's number badge, showing the comment and its replies.
 * The layer only places cards; LiveSession decides which are open and builds their content.
 * <ul>
 * <li>Cards sit to the right of the badge, or to the left near the page's right edge, and are pushed down so open cards
 * never overlap.</li>
 * <li>Positions are in document coordinates, so cards scroll with the page.</li>
 * <li>Rebuilding a card keeps a reply being typed in it: the focused box gets its focus and selection back.</li>
 * <li>With `within`, the cards live inside that element (which must be positioned) instead of on the whole page.</li>
 * </ul>
 */

import { innerOrigin } from "./anchoring";
import BUBBLE_STYLES from "./styles/bubbles.css?inline";

export interface BubblePosition {
  x: number;
  y: number;
}

const WIDTH = 300;
const GAP = 8;
const OFFSET_X = 18;
const OFFSET_Y = 16;

export class BubbleLayer {
  readonly host: HTMLElement;
  readonly #root: HTMLDivElement;
  readonly #cards = new Map<string, HTMLDivElement>();
  readonly #within: HTMLElement | null;
  #positions: Record<string, BubblePosition> = {};
  #frame = 0;

  constructor(styles: string, onEnter: () => void, onLeave: () => void, options: { within?: HTMLElement } = {}) {
    this.#within = options.within ?? null;
    this.host = document.createElement("inklayer-bubbles");
    this.host.setAttribute("style", "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;");
    const shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = styles + BUBBLE_STYLES;
    shadow.append(style);
    this.#root = document.createElement("div");
    this.#root.className = "bubbles";
    this.#root.style.setProperty("--bubble-width", `${WIDTH}px`);
    this.#root.addEventListener("mouseover", onEnter);
    this.#root.addEventListener("mouseleave", onLeave);
    // Typing in a bubble shouldn't trigger the page's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"] as const)
      this.#root.addEventListener(type, (e) => e.stopPropagation());
    shadow.append(this.#root);
    this.#parent.append(this.host);
  }

  get #parent(): HTMLElement {
    return this.#within ?? document.documentElement;
  }

  get root(): HTMLElement {
    return this.#root;
  }

  ensureAttached(): void {
    if (!this.host.isConnected) this.#parent.append(this.host);
  }

  setPositions(positions: Record<string, BubblePosition>): void {
    this.#positions = positions;
    this.#layoutSoon();
  }

  /** Shows a card for each id (in that order), with content from `build`; removes the rest. */
  show(ids: string[], build: (id: string) => Node[]): void {
    this.showEach(ids, (id, card) => card.replaceChildren(...build(id)));
  }

  /**
   * Shows a card for each id, letting `fill` put the content in the card element itself (for code that renders into
   * an element, like a UI library); removes the rest, calling `release` on each card removed.
   */
  showEach(ids: string[], fill: (id: string, card: HTMLElement) => void, release?: (card: HTMLElement) => void): void {
    const active =
      this.#root.getRootNode() instanceof ShadowRoot ? (this.#root.getRootNode() as ShadowRoot).activeElement : null;
    const focus =
      active instanceof HTMLTextAreaElement
        ? { el: active, start: active.selectionStart, end: active.selectionEnd }
        : null;

    const wanted = new Set(ids.filter((id) => this.#positions[id]));
    for (const [id, card] of this.#cards) {
      if (!wanted.has(id)) {
        release?.(card);
        card.remove();
        this.#cards.delete(id);
      }
    }
    for (const id of wanted) {
      let card = this.#cards.get(id);
      if (!card) {
        card = document.createElement("div");
        card.className = "bubble";
        card.dataset.id = id;
        this.#cards.set(id, card);
        this.#root.append(card);
      }
      fill(id, card);
    }

    if (focus?.el.isConnected) {
      focus.el.focus();
      focus.el.setSelectionRange(focus.start, focus.end);
    }
    this.#layoutSoon();
  }

  hasFocus(id: string): boolean {
    const root = this.#root.getRootNode() as ShadowRoot;
    return !!root.activeElement && this.#cards.get(id)?.contains(root.activeElement) === true;
  }

  destroy(): void {
    cancelAnimationFrame(this.#frame);
    this.host.remove();
  }

  #layoutSoon(): void {
    if (!this.#frame)
      this.#frame = requestAnimationFrame(() => {
        this.#frame = 0;
        this.#layout();
      });
  }

  /** Beside each badge; cards on the same side are pushed down until they don't overlap. Reads all sizes before writing. */
  #layout(): void {
    // Positions are in document coordinates; inside `within`, the cards' origin is that element's corner, and its right edge is the limit.
    const origin = this.#within ? innerOrigin(this.#within) : { x: 0, y: 0 };
    this.host.style.transform = this.#within ? `translate(${-origin.x}px, ${-origin.y}px)` : "";
    const pageWidth = this.#within
      ? origin.x + this.#within.clientWidth
      : Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth);
    const cards = [...this.#cards]
      .map(([id, card]) => {
        const at = this.#positions[id]!;
        const right = at.x + OFFSET_X + WIDTH + GAP <= pageWidth;
        return { card, at, right, height: card.offsetHeight, top: at.y - OFFSET_Y };
      })
      .sort((a, b) => a.at.y - b.at.y);

    const placed: { left: number; top: number; bottom: number }[] = [];
    for (const c of cards) {
      const left = c.right ? c.at.x + OFFSET_X : Math.max(origin.x + GAP, c.at.x - OFFSET_X - WIDTH);
      let top = Math.max(origin.y + GAP, c.top);
      for (const p of placed) {
        if (Math.abs(p.left - left) < WIDTH && top < p.bottom + GAP && top + c.height > p.top) top = p.bottom + GAP;
      }
      placed.push({ left, top, bottom: top + c.height });
      c.card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      c.card.classList.toggle("left", !c.right);
    }
  }
}
