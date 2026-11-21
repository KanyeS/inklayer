import effectsCss from "./styles/effects.css?inline";

/**
 * While the tab is being recorded: rings where the person clicks, so viewers can see the clicks, and a pen that draws
 * lines that fade, for pointing things out. Drawn on the page (just under Inklayer's panel) so they're in the recording;
 * nothing shows when it isn't recording.
 */

/** How long a click's ring and a drawn line take to fade, in milliseconds. */
export const RING_MS = 650;
export const FADE_MS = 1500;
const PEN = "#ef4444";

interface Point {
  x: number;
  y: number;
  at: number;
}

/** How visible a drawn point is `age` ms after it was drawn: fully at first, then fading out. Exported for tests. */
export function fadeOf(age: number): number {
  if (age <= FADE_MS * 0.4) return 1;
  return Math.max(0, 1 - (age - FADE_MS * 0.4) / (FADE_MS * 0.6));
}

export class RecordingEffects {
  #recording = false;
  #drawing = false;
  #host: HTMLElement | null = null;
  #root: ShadowRoot | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #hint: HTMLElement | null = null;
  #strokes: Point[][] = [];
  #current: Point[] | null = null;
  #frame = 0;

  readonly #onClick = (e: PointerEvent) => {
    if (this.#recording && !this.#drawing && e.isPrimary) this.#ring(e.clientX, e.clientY);
  };

  readonly #onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.#drawing) this.#setDrawing(false);
  };

  /** The tab started or stopped being recorded. */
  setRecording(on: boolean): void {
    if (on === this.#recording) return;
    this.#recording = on;
    if (on) {
      this.#ensureHost();
      document.addEventListener("pointerdown", this.#onClick, { capture: true, passive: true });
      document.addEventListener("keydown", this.#onKey, true);
    } else {
      document.removeEventListener("pointerdown", this.#onClick, true);
      document.removeEventListener("keydown", this.#onKey, true);
      this.#setDrawing(false);
      this.#host?.remove();
      this.#host = null;
    }
  }

  toggleDrawing(): void {
    if (this.#recording) this.#setDrawing(!this.#drawing);
  }

  #ensureHost(): void {
    if (this.#host?.isConnected) return;
    const host = document.createElement("inklayer-effects");
    host.setAttribute("style", "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;");
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = effectsCss;
    const canvas = document.createElement("canvas");
    canvas.addEventListener("pointerdown", (e) => this.#penDown(e));
    canvas.addEventListener("pointermove", (e) => this.#penMove(e));
    canvas.addEventListener("pointerup", () => this.#penUp());
    canvas.addEventListener("pointercancel", () => this.#penUp());
    root.append(style, canvas);
    document.documentElement.append(host);
    this.#host = host;
    this.#root = root;
    this.#canvas = canvas;
  }

  #ring(x: number, y: number): void {
    const ring = document.createElement("div");
    ring.className = "ring";
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    this.#root?.append(ring);
    setTimeout(() => ring.remove(), RING_MS);
  }

  #setDrawing(on: boolean): void {
    this.#drawing = on;
    this.#canvas?.classList.toggle("drawing", on);
    if (on && !this.#hint) {
      this.#hint = document.createElement("div");
      this.#hint.className = "hint";
      this.#hint.textContent = "Drawing · Esc to stop";
      this.#root?.append(this.#hint);
    } else if (!on) {
      this.#hint?.remove();
      this.#hint = null;
      this.#penUp();
    }
  }

  #penDown(e: PointerEvent): void {
    if (!this.#drawing) return;
    this.#canvas?.setPointerCapture(e.pointerId);
    this.#current = [{ x: e.clientX, y: e.clientY, at: performance.now() }];
    this.#strokes.push(this.#current);
    this.#animate();
  }

  #penMove(e: PointerEvent): void {
    this.#current?.push({ x: e.clientX, y: e.clientY, at: performance.now() });
  }

  #penUp(): void {
    this.#current = null;
  }

  /** Redraws the lines each frame, each part fading with its age, until they've all gone. */
  #animate(): void {
    if (this.#frame) return;
    const step = () => {
      this.#frame = 0;
      const canvas = this.#canvas;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const ratio = devicePixelRatio || 1;
      if (canvas.width !== Math.round(innerWidth * ratio) || canvas.height !== Math.round(innerHeight * ratio)) {
        canvas.width = Math.round(innerWidth * ratio);
        canvas.height = Math.round(innerHeight * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 4;
      ctx.strokeStyle = PEN;
      ctx.shadowColor = PEN;
      ctx.shadowBlur = 6;
      const now = performance.now();
      this.#strokes = this.#strokes
        .map((stroke) => (stroke === this.#current ? stroke : stroke.filter((p) => now - p.at < FADE_MS)))
        .filter((stroke) => stroke.length > 0);
      for (const stroke of this.#strokes) {
        for (let i = 1; i < stroke.length; i++) {
          const [a, b] = [stroke[i - 1] as Point, stroke[i] as Point];
          ctx.globalAlpha = fadeOf(now - b.at);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (this.#strokes.length > 0) this.#frame = requestAnimationFrame(step);
    };
    this.#frame = requestAnimationFrame(step);
  }
}
