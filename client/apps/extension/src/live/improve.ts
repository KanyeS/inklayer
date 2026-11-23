import { type Draft, resolveElement } from "@inklayer/overlay";
import { IMPROVE_HINT_HIDDEN } from "../lib/claude-helper";
import { call, messageOf, remember } from "./call";
import type { TextDraft } from "./suggestions";

/**
 * The Improve button in a comment box: sends the draft to the local Claude helper (through the background; see
 * lib/claude-helper.ts) and puts the rewrite in the box, with Undo. One box at a time; keys tell boxes apart.
 */

/** What a comment box shows for it. */
export interface ImproveControls {
  busy: boolean;
  error: string | null;
  /** The text is still Claude's rewrite, so Undo can put the draft back. */
  canUndo: boolean;
  onImprove(): void;
  onUndo(): void;
}

/** What the page says about the comment's element, to help name things. */
export interface ImproveContext {
  url: string;
  selector?: string;
  elementText?: string;
}

interface BoxState {
  key: string;
  busy: boolean;
  error: string | null;
  before: TextDraft | null;
  improved: string | null;
}

/** The offer to set the helper up, under the comment box while it isn't. */
export interface ImproveHint {
  onSetUp(): void;
  onHide(): void;
}

/** The comment boxes Improve works in, as the session keeps them. */
export interface ImproveBoxes {
  /** The local Claude helper is on (popup → Settings) and installed. */
  enabled(): boolean;
  /** Offer to set it up (it isn't, this browser can use it, and the person didn't hide the offer). */
  offerSetUp?(): boolean;
  render(): void;
  /** The new comment being written, if any: its element (for context), text, page and box number. */
  draft(): { draft: Draft; text: TextDraft; url: string; number: number } | null;
  setDraftText(text: TextDraft): void;
  /** The comment being edited, if any. */
  editing(): { id: string; draft: TextDraft } | null;
  setEditing(editing: { id: string; draft: TextDraft }): void;
}

export class Improver {
  #state: BoxState | null = null;
  #hintHidden = false;
  readonly #boxes: ImproveBoxes;

  constructor(boxes: ImproveBoxes) {
    this.#boxes = boxes;
  }

  /**
   * The "set up" link under the new comment's box: it opens the setup in a tab (a page can't open the popup). "Don't
   * show this" hides it for good, on every site.
   */
  setUpHint(): ImproveHint | null {
    if (this.#hintHidden || this.#boxes.enabled() || !this.#boxes.offerSetUp?.()) return null;
    return {
      onSetUp: () => void call({ type: "live.improveSetup" }).catch(() => undefined),
      onHide: () => {
        this.#hintHidden = true;
        remember({ [IMPROVE_HINT_HIDDEN]: true });
        this.#boxes.render();
      },
    };
  }

  /** The controls for the new comment's box; null when the helper is off. */
  forDraft(): ImproveControls | null {
    const b = this.#boxes;
    const number = b.draft()?.number;
    if (!b.enabled() || number === undefined) return null;
    return this.controls(
      `draft:${number}`,
      () => b.draft()?.text ?? null,
      (text) => b.setDraftText(text),
      () => {
        const d = b.draft();
        return d ? { url: d.url, ...improveContext(d.draft) } : { url: location.href };
      },
    );
  }

  /** The controls for the box of comment `id` while it's being edited; null when the helper is off. */
  forEdit(id: string): ImproveControls | null {
    const b = this.#boxes;
    if (!b.enabled()) return null;
    return this.controls(
      `edit:${id}`,
      () => (b.editing()?.id === id ? (b.editing()?.draft ?? null) : null),
      (draft) => b.editing()?.id === id && b.setEditing({ id, draft }),
      () => ({ url: location.href }),
    );
  }

  /**
   * The controls for one box. `current` reads the box's text now (null once the box is gone); `apply` replaces it.
   */
  controls(
    key: string,
    current: () => TextDraft | null,
    apply: (draft: TextDraft) => void,
    context: () => ImproveContext,
  ): ImproveControls {
    const state = this.#state?.key === key ? this.#state : null;
    const text = current()?.text ?? "";
    return {
      busy: state?.busy ?? false,
      error: state?.error ?? null,
      canUndo: Boolean(state?.before && state.improved === text),
      onImprove: () => void this.#improve(key, current, apply, context),
      onUndo: () => {
        const s = this.#state;
        if (s?.key !== key || !s.before) return;
        apply(s.before);
        this.#state = null;
        this.#boxes.render();
      },
    };
  }

  /** Forget a box (it was saved or cancelled). */
  reset(): void {
    this.#state = null;
  }

  async #improve(
    key: string,
    current: () => TextDraft | null,
    apply: (draft: TextDraft) => void,
    context: () => ImproveContext,
  ): Promise<void> {
    const before = current();
    if (!before || this.#state?.busy) return;
    if (!before.text.trim()) {
      this.#state = { key, busy: false, error: "Write something first.", before: null, improved: null };
      this.#boxes.render();
      return;
    }
    const state: BoxState = { key, busy: true, error: null, before: null, improved: null };
    this.#state = state;
    this.#boxes.render();
    try {
      const text = await call<string>({ type: "live.improve", ...context(), text: before.text });
      if (this.#state !== state) return; // the box was saved, cancelled or another one started
      const now = current();
      if (!now) return;
      if (now.text !== before.text) {
        state.error = "The comment changed while Claude was working on it. Try again.";
      } else {
        state.before = before;
        state.improved = text;
        // @names picked from suggestions keep their people: the rewrite keeps the names as written.
        apply({ text, picked: before.picked });
      }
    } catch (error) {
      if (this.#state !== state) return;
      state.error = messageOf(error);
    }
    state.busy = false;
    this.#boxes.render();
  }
}

/** Longest element text sent along; the background caps it again. */
const MAX_ELEMENT_TEXT = 500;

/** The new comment's element: its selector, and its visible text or label, so Claude can name it. */
export function improveContext(draft: Draft): Omit<ImproveContext, "url"> {
  const selector = draft.anchor.element.path.join(" >>> ");
  const element = resolveElement(document, draft.anchor.element).element;
  const label = element?.getAttribute("aria-label") || element?.textContent || "";
  const elementText = label.replace(/\s+/g, " ").trim().slice(0, MAX_ELEMENT_TEXT);
  return elementText ? { selector, elementText } : { selector };
}
