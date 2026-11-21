/**
 * Runs `run` once the page stops changing: `delayMs` after the last `poke`, but at least every `maxWaitMs` while it keeps
 * changing, so marks catch up with a page that never settles. Used to re-anchor comments after the page's content changes.
 */
export class SettleTimer {
  readonly #run: () => void;
  readonly #delayMs: number;
  readonly #maxWaitMs: number;
  #timer = 0;
  #since = 0;

  constructor(run: () => void, delayMs: number, maxWaitMs: number) {
    this.#run = run;
    this.#delayMs = delayMs;
    this.#maxWaitMs = maxWaitMs;
  }

  poke(): void {
    const now = Date.now();
    if (!this.#timer) this.#since = now;
    clearTimeout(this.#timer);
    const wait = now - this.#since > this.#maxWaitMs ? 0 : this.#delayMs;
    this.#timer = window.setTimeout(() => {
      this.#timer = 0;
      this.#run();
    }, wait);
  }
}
