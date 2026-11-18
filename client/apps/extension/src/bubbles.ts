/**
 * Comment bubbles next to marks on the page: a card beside each mark's number badge, showing the comment and its replies.
 * The layer only places cards; LiveSession decides which are open and builds their content.
 * <ul>
 * <li>Cards sit to the right of the badge, or to the left near the page's right edge, and are pushed down so open cards
 * never overlap.</li>
 * <li>Positions are in document coordinates, so cards scroll with the page.</li>
 * <li>Rebuilding a card keeps a reply being typed in it: the focused box gets its focus and selection back.</li>
 * </ul>
 */

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
  #positions: Record<string, BubblePosition> = {};
  #frame = 0;

  constructor(styles: string, onEnter: () => void, onLeave: () => void) {
    this.host = document.createElement("inklayer-bubbles");
    this.host.setAttribute("style", "all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;");
    const shadow = this.host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>${styles}${BUBBLE_STYLES}</style>`;
    this.#root = document.createElement("div");
    this.#root.className = "bubbles";
    this.#root.addEventListener("mouseover", onEnter);
    this.#root.addEventListener("mouseleave", onLeave);
    // Typing in a bubble shouldn't trigger the page's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"] as const) this.#root.addEventListener(type, (e) => e.stopPropagation());
    shadow.append(this.#root);
    document.documentElement.append(this.host);
  }

  get root(): HTMLElement {
    return this.#root;
  }

  ensureAttached(): void {
    if (!this.host.isConnected) document.documentElement.append(this.host);
  }

  setPositions(positions: Record<string, BubblePosition>): void {
    this.#positions = positions;
    this.#layoutSoon();
  }

  /** Shows a card for each id (in that order), with content from `build`; removes the rest. */
  show(ids: string[], build: (id: string) => Node[]): void {
    const active = this.#root.getRootNode() instanceof ShadowRoot ? (this.#root.getRootNode() as ShadowRoot).activeElement : null;
    const focus = active instanceof HTMLTextAreaElement ? { el: active, start: active.selectionStart, end: active.selectionEnd } : null;

    const wanted = new Set(ids.filter((id) => this.#positions[id]));
    for (const [id, card] of this.#cards) {
      if (!wanted.has(id)) {
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
      card.replaceChildren(...build(id));
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
    if (!this.#frame) this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#layout();
    });
  }

  /** Beside each badge; cards on the same side are pushed down until they don't overlap. Reads all sizes before writing. */
  #layout(): void {
    const pageWidth = Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth);
    const cards = [...this.#cards].map(([id, card]) => {
      const at = this.#positions[id]!;
      const right = at.x + OFFSET_X + WIDTH + GAP <= pageWidth;
      return { card, at, right, height: card.offsetHeight, top: at.y - OFFSET_Y };
    }).sort((a, b) => a.at.y - b.at.y);

    const placed: { left: number; top: number; bottom: number }[] = [];
    for (const c of cards) {
      const left = c.right ? c.at.x + OFFSET_X : Math.max(GAP, c.at.x - OFFSET_X - WIDTH);
      let top = Math.max(GAP, c.top);
      for (const p of placed) {
        if (Math.abs(p.left - left) < WIDTH && top < p.bottom + GAP && top + c.height > p.top) top = p.bottom + GAP;
      }
      placed.push({ left, top, bottom: top + c.height });
      c.card.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
      c.card.classList.toggle("left", !c.right);
    }
  }
}

const BUBBLE_STYLES = `
  .bubbles { position: absolute; top: 0; left: 0; width: 0; height: 0; }
  .bubble { position: absolute; top: 0; left: 0; width: ${WIDTH}px; box-sizing: border-box; max-height: 360px; overflow-y: auto;
    padding: 10px 12px; border-radius: 16px; background: var(--popover, var(--background)); color: var(--popover-foreground, var(--foreground));
    border: 1px solid var(--border); box-shadow: 0 1px 3px rgb(0 0 0 / .12), 0 10px 30px rgb(0 0 0 / .14);
    font: 13px/1.45 "Inklayer Outfit", system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; gap: 6px;
    animation: bubble-in .12s ease-out; }
  .bubble.resolved { opacity: .8; }
  @keyframes bubble-in { from { opacity: 0; transform-origin: left top; } to { opacity: 1; } }
  .bubble-head { display: flex; align-items: center; gap: 6px; }
  .bubble-head .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .bubble-head .grow { flex: 1; }
  .pin-toggle { border: none; background: none; padding: 3px; border-radius: 8px; cursor: pointer; color: var(--muted-foreground); display: grid; place-items: center; }
  .pin-toggle:hover { background: var(--muted); color: var(--foreground); }
  .pin-toggle.on { color: var(--primary); background: color-mix(in oklab, var(--primary) 12%, transparent); }
  .pin-toggle svg { width: 15px; height: 15px; }
  .replies { display: flex; flex-direction: column; gap: 6px; margin: 2px 0 0; padding: 6px 0 0 10px; border-top: 1px solid var(--border); list-style: none; }
  .reply { display: flex; flex-direction: column; gap: 1px; }
  .reply .meta { font-size: 12px; }
  .reply-box { width: 100%; box-sizing: border-box; resize: none; min-height: 34px; }
  .bubble .row { display: flex; gap: 4px; align-items: center; }
`;
