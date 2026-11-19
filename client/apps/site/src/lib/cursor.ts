import { anchorFor, documentBox, type Point } from "@inklayer/overlay";
import { textRange } from "./dom";
import type { Person } from "./people";
import type { Ctx } from "./scene";
import type { Stage } from "./stage";

/** The pretend team's pointers on the demos: gliding, selecting text, dragging and drawing like real people. */

/** How far off a straight line a cursor's path can bow, as a fraction of the distance. */
const MAX_BEND = 0.36;

/**
 * A point `t` (0..1) of the way from `from` to `to`, on a slight curve like a hand on a mouse. `bend` is how far it
 * bows sideways at the middle, as a fraction of the distance; the ends are exact.
 */
export function curvedPoint(from: Point, to: Point, t: number, bend: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const curve = Math.sin(Math.PI * t) * bend;
  return { x: from.x + dx * t - dy * curve, y: from.y + dy * t + dx * curve };
}

/** Where to move a cursor: a spot on an element (fractions of its box), or any document point. */
export type Target = { el: Element; x?: number; y?: number } | (() => Point);

/** One pretend person's pointer and text selection on a stage, drawn by the real PresenceLayer. */
export class Cursor {
  #at: Point | null = null;

  constructor(
    readonly stage: Stage,
    readonly person: Person,
  ) {
    stage.presence.addPeer({
      id: person.id,
      name: person.name,
      color: person.color,
      fullName: `${person.name} · ${person.role}`,
    });
  }

  /** The target's position in document coordinates, worked out now (elements move). */
  static point(target: Target): Point {
    if (typeof target === "function") return target();
    const box = documentBox(target.el);
    return { x: box.x + box.width * (target.x ?? 0.5), y: box.y + box.height * (target.y ?? 0.5) };
  }

  place(point: Point): void {
    this.#at = point;
    this.stage.presence.placeAt(this.person.id, point);
  }

  /** Glides to the target over `ms`, on a slight curve like a hand on a mouse. Appears there first if it hasn't moved yet. */
  async moveTo(ctx: Ctx, target: Target, ms = 900): Promise<void> {
    const from = this.#at;
    if (!from) {
      this.place(Cursor.point(target));
      return ctx.sleep(ms / 3);
    }
    const bend = (Math.random() - 0.5) * MAX_BEND;
    await ctx.animate(ms, (t) => this.place(curvedPoint(from, Cursor.point(target), t, bend)));
  }

  /** Drags across text to select `phrase` inside `el`; the selection shows in the person's colour with their name. */
  async select(ctx: Ctx, el: Element, phrase: string, ms = 900): Promise<void> {
    const full = textRange(el, phrase);
    const range = full.cloneRange();
    range.collapse(true);
    await this.moveTo(ctx, () => rangeEdge(full, "start"));
    await ctx.animate(
      ms,
      (t) => {
        range.setEnd(full.startContainer, full.startOffset + Math.round((full.endOffset - full.startOffset) * t));
        if (!range.collapsed) this.stage.presence.setSelection(this.person.id, anchorFor(el, range));
        this.place(rangeEdge(range, "end"));
      },
      true,
    );
  }

  clearSelection(): void {
    this.stage.presence.setSelection(this.person.id, null);
  }

  /** Drags from one point of `el` to another, calling `drawTo` with the current point as fractions of el's box. */
  async drag(ctx: Ctx, el: Element, from: Point, to: Point, drawTo: (p: Point) => void, ms = 800): Promise<void> {
    await this.moveTo(ctx, { el, x: from.x, y: from.y });
    await ctx.animate(ms, (t) => {
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      drawTo(p);
      this.place(Cursor.point({ el, ...p }));
    });
  }

  /** Draws through `points` (fractions of el's box), calling `drawTo` with the points so far. */
  async trace(ctx: Ctx, el: Element, points: Point[], drawTo: (soFar: Point[]) => void, ms = 1100): Promise<void> {
    const [first] = points;
    if (!first) return;
    await this.moveTo(ctx, { el, ...first });
    await ctx.animate(
      ms,
      (t) => {
        const upTo = Math.max(1, Math.round(t * (points.length - 1)));
        drawTo(points.slice(0, upTo + 1));
        const at = points[upTo];
        if (at) this.place(Cursor.point({ el, ...at }));
      },
      true,
    );
  }

  /** Lets go of the mouse: after ten seconds without moving, the real layer fades the cursor. Here, at once. */
  hide(): void {
    this.#at = null;
    this.stage.presence.placeAt(this.person.id, null);
  }
}

/** The start or end of a range, in document coordinates (a little below the top of the line, where a pointer would be). */
function rangeEdge(range: Range, edge: "start" | "end"): Point {
  const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
  const r = (edge === "start" ? rects[0] : rects[rects.length - 1]) ?? range.getBoundingClientRect();
  return { x: (edge === "start" ? r.left : r.right) + scrollX, y: r.top + r.height * 0.65 + scrollY };
}
