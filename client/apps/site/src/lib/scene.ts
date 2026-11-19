/**
 * Scenes: each section's demo is an async script that runs while the section is on screen, pauses when it scrolls away,
 * and loops. Scripts wait with `ctx.sleep` and animate with `ctx.animate`, which only count on-screen time, so a scene
 * picks up where it left off. With prefers-reduced-motion, waits are skipped and each scene runs once to its end state.
 */

export const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Thrown inside a script when its scene is stopped or restarted; the runner swallows it. */
const STOPPED = Symbol("stopped");

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** One run of a scene's script. Every wait checks that the run is still wanted. */
export class Ctx {
  #alive = true;

  constructor(readonly scene: Scene) {}

  stop(): void {
    this.#alive = false;
  }

  /** Throws if the scene was stopped, ending the script. */
  check(): void {
    if (!this.#alive) throw STOPPED;
  }

  /** Waits until the section is on screen. */
  async onScreen(): Promise<void> {
    while (!this.scene.visible) {
      this.check();
      await this.scene.untilVisible();
    }
    this.check();
  }

  /** Waits for `ms` of on-screen time. */
  async sleep(ms: number): Promise<void> {
    if (reducedMotion) return this.check();
    for (let left = ms; left > 0; left -= 80) {
      await this.onScreen();
      await new Promise((resolve) => setTimeout(resolve, Math.min(left, 80)));
    }
    this.check();
  }

  /** Calls `step` every frame with progress from 0 to 1 over `ms` of on-screen time (eased unless `linear`). */
  async animate(ms: number, step: (t: number) => void, linear = false): Promise<void> {
    if (reducedMotion) {
      step(1);
      return this.check();
    }
    let elapsed = 0;
    let last = performance.now();
    while (elapsed < ms) {
      if (!this.scene.visible) {
        await this.onScreen();
        last = performance.now();
      }
      const now = await nextFrame();
      this.check();
      elapsed += Math.min(now - last, 50);
      last = now;
      const t = Math.min(1, elapsed / ms);
      step(linear ? t : easeInOut(t));
    }
    this.check();
  }

  /** Types `text` a character at a time, handing `write` the text so far. */
  async type(text: string, write: (soFar: string) => void, charsPerSecond = 26): Promise<void> {
    if (reducedMotion) return write(text);
    for (let i = 1; i <= text.length; i++) {
      write(text.slice(0, i));
      const pause = 1000 / charsPerSecond;
      await this.sleep(text[i - 1] === " " ? pause * 1.6 : pause * (0.6 + Math.random() * 0.8));
    }
  }
}

export interface SceneOptions {
  /** Pause between loops, in ms. */
  gap?: number;
  /** Run once instead of looping. */
  once?: boolean;
  /** Puts the section back to its starting state between loops. */
  reset?: () => void;
}

export class Scene {
  /** Running: on screen, and the team isn't switched off. */
  visible = false;
  #onScreen = false;
  #waiting: (() => void)[] = [];
  #run: Ctx | null = null;

  constructor(
    readonly root: Element,
    readonly script: (ctx: Ctx) => Promise<void>,
    readonly options: SceneOptions = {},
  ) {
    visibility.observe(root);
    scenes.set(root, this);
  }

  untilVisible(): Promise<void> {
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  setOnScreen(onScreen: boolean): void {
    this.#onScreen = onScreen;
    this.update();
  }

  update(): void {
    this.visible = this.#onScreen && !paused;
    if (this.visible) this.#wake();
  }

  #wake(): void {
    for (const resolve of this.#waiting.splice(0)) resolve();
  }

  /** Stops the script (for good, until `start`). */
  stop(): void {
    this.#run?.stop();
    this.#wake();
  }

  /** Starts the script from the beginning, stopping any run in progress. */
  start(): void {
    this.stop();
    const ctx = new Ctx(this);
    this.#run = ctx;
    void (async () => {
      const { gap = 2400, once = false, reset } = this.options;
      try {
        for (;;) {
          await ctx.onScreen();
          await this.script(ctx);
          if (reducedMotion || once) break;
          await ctx.sleep(gap);
          reset?.();
        }
      } catch (error) {
        if (error !== STOPPED) console.debug("[inklayer demo]", error);
      }
    })();
  }
}

const scenes = new Map<Element, Scene>();
const visibility = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) scenes.get(entry.target)?.setOnScreen(entry.isIntersecting);
  },
  { threshold: 0.12 },
);

let paused = false;

/** Pauses every scene (the "Demo people" switch is off) or resumes them where they left off. */
export function pauseScenes(pause: boolean): void {
  paused = pause;
  for (const s of scenes.values()) s.update();
}

/** Creates a scene for the section and starts it. */
export function scene(root: Element, script: (ctx: Ctx) => Promise<void>, options?: SceneOptions): Scene {
  const s = new Scene(root, script, options);
  s.start();
  return s;
}

/** Runs several actions at once (people working at the same time). */
export const together = (...actions: Promise<unknown>[]) => Promise.all(actions);

export const random = (min: number, max: number) => min + Math.random() * (max - min);
export const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;
