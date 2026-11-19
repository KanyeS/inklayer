import { clampPosition, DEFAULT_POSITION, type PanelPosition, parsePosition } from "../lib/panelPosition";
import { remember } from "./call";
import { FORM_CONTROLS } from "./views/chrome";

/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 5;

const PINNED_HINT = "Pinned in place. Click the pin icon to unpin, then drag the header to move the panel.";

/**
 * Where the live panel sits, and dragging it there. The place and whether it's pinned are remembered in the
 * extension's storage, so they're the same on every site (and follow when another tab changes them).
 */
export class PanelMover {
  readonly #host: HTMLElement;
  readonly #onNote: (text: string) => void;
  readonly #onChange: () => void;
  /** Where the panel was dragged to. */
  #position: PanelPosition = DEFAULT_POSITION;
  /** Pinned (the default): the panel stays where it is. Unpin it to drag it somewhere else. */
  pinned = true;
  /** Set when a drag ends, so the release doesn't also press what's under it. */
  #dragged = false;

  /**
   * @param host The panel's host element, positioned with `right` and `bottom`.
   * @param onNote Shows a short message in the panel (how to move it while pinned).
   * @param onChange The pinned state changed: redraw.
   */
  constructor(host: HTMLElement, onNote: (text: string) => void, onChange: () => void) {
    this.#host = host;
    this.#onNote = onNote;
    this.#onChange = onChange;
  }

  /** A drag just ended: the click that follows shouldn't press anything. */
  get justDragged(): boolean {
    return this.#dragged;
  }

  /** Takes the remembered place and pinned state from storage. */
  restore(stored: { panelPosition?: unknown; panelPinned?: unknown }): void {
    this.pinned = stored.panelPinned !== false;
    this.#position = parsePosition(stored.panelPosition) ?? DEFAULT_POSITION;
    this.place();
  }

  /** Another tab moved or pinned the panel: follow. Returns whether anything changed. */
  follow(changes: Record<string, chrome.storage.StorageChange>): boolean {
    let changed = false;
    if (changes.panelPinned) {
      this.pinned = changes.panelPinned.newValue !== false;
      changed = true;
    }
    if (changes.panelPosition) {
      this.#position = parsePosition(changes.panelPosition.newValue) ?? DEFAULT_POSITION;
      this.place();
    }
    return changed;
  }

  /** Puts the panel at its position, kept inside the window. */
  place(): void {
    const box = this.#host.getBoundingClientRect();
    this.#moveTo(clampPosition(this.#position, box, { width: innerWidth, height: innerHeight }));
  }

  setPinned(pinned: boolean): void {
    this.pinned = pinned;
    remember({ panelPinned: pinned });
    this.#onChange();
  }

  /** Back to the bottom-right corner (double-click the header while unpinned). */
  reset(): void {
    this.#position = DEFAULT_POSITION;
    this.place();
    remember({ panelPosition: DEFAULT_POSITION });
  }

  #moveTo(position: PanelPosition): void {
    this.#host.style.right = `${position.right}px`;
    this.#host.style.bottom = `${position.bottom}px`;
  }

  /**
   * Drags the panel by its header (tabs and icons included) or the collapsed button. A press that doesn't move is
   * still a click. While pinned, a drag only explains how to move it.
   */
  startDrag(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as Element).closest(FORM_CONTROLS)) return;
    const handle = e.currentTarget as HTMLElement;
    const box = this.#host.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, right: innerWidth - box.right, bottom: innerHeight - box.bottom };
    let moved = false;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return; // still a click
        moved = true;
        if (this.pinned) {
          end();
          // The collapsed button can't show a note; the open panel can.
          if (!handle.classList.contains("launcher")) this.#onNote(PINNED_HINT);
          return;
        }
        // Captured only once it's a drag, so plain clicks still reach the button pressed.
        handle.setPointerCapture(ev.pointerId);
        handle.classList.add("dragging");
      }
      this.#position = clampPosition({ right: start.right - dx, bottom: start.bottom - dy }, box, {
        width: innerWidth,
        height: innerHeight,
      });
      this.#moveTo(this.#position);
    };
    const end = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      handle.classList.remove("dragging");
      if (!moved || this.pinned) return;
      // The release after a drag isn't a click on whatever is under it.
      this.#dragged = true;
      window.setTimeout(() => {
        this.#dragged = false;
      }, 0);
      remember({ panelPosition: this.#position });
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }
}
