/**
 * Work for the next frame, done once however often it's asked for in between: placing the panel and drawing the bubbles
 * after a change. Measuring straight after a change makes the browser lay out the whole page, which is slow on big pages
 * (and was felt as lag when typing); in the next frame it's laid out anyway.
 */
export class NextFrame {
  #frame = 0;
  #full = false;
  readonly #run: (full: boolean) => void;

  /** `run(full)`: `full` when any request since the last frame asked for everything, not just the panel. */
  constructor(run: (full: boolean) => void) {
    this.#run = run;
  }

  request(full: boolean): void {
    this.#full ||= full;
    this.#frame ||= requestAnimationFrame(() => {
      this.#frame = 0;
      const all = this.#full;
      this.#full = false;
      this.#run(all);
    });
  }
}
