/** How long a note stays. */
const NOTE_SHOWN_MS = 8000;

/** A short message under the panel's header (sharing results, how to move the panel), shown for a few seconds. */
export class FlashNote {
  /** What's shown now; empty for nothing. */
  text = "";
  readonly #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  show(text: string): void {
    this.text = text;
    this.#onChange();
    window.setTimeout(() => {
      if (this.text !== text) return;
      this.text = "";
      this.#onChange();
    }, NOTE_SHOWN_MS);
  }
}
