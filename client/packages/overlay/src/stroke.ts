import { boundsOf, toFraction } from "./geometry";
import { INK_SIZE, type StrokePoint } from "./shapes";
import type { Box, Geometry, Tool } from "./types";

/**
 * Turning a finished stroke with a drawing tool (box, arrow, ink) into the geometry that's saved. Pure, and
 * unit-tested in test/shapes.test.ts.
 */

/** The tools that draw on the page (the others pick elements or text). */
export const DRAWING_TOOLS: ReadonlySet<Tool> = new Set(["rect", "arrow", "ink"]);

/** Smaller than this (in both directions) is a click, not a drawing. */
const MIN_DRAWING_PX = 4;

/** A stroke being drawn: the tool and its points in document coordinates. */
export interface Stroke {
  tool: Tool;
  points: StrokePoint[];
}

/** Pen pressure for a pointer event; mice and touch report none, so they get the middle. */
export function pressure(e: Pick<PointerEvent, "pointerType" | "pressure">): number {
  return e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
}

/** Rounds to 4 decimals, so saved fractions stay short. */
export function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** The stroke's bounding box, or null if it's too small to be a drawing (a click). */
export function strokeBounds(stroke: Stroke): Box | null {
  if (stroke.points.length < 2) return null;
  const bounds = boundsOf(stroke.points.map(([x, y]) => ({ x, y })));
  return bounds.width < MIN_DRAWING_PX && bounds.height < MIN_DRAWING_PX ? null : bounds;
}

/** The geometry to save for a stroke, as fractions of the box of the element it's anchored to. */
export function strokeGeometry(stroke: Stroke, box: Box): Geometry {
  if (stroke.tool === "ink") {
    const points = stroke.points.map(([x, y, p]): StrokePoint => {
      const f = toFraction({ x, y }, box);
      return [round(f.x), round(f.y), round(p)];
    });
    return { kind: "Ink", size: INK_SIZE, points };
  }
  const first = stroke.points[0] ?? [0, 0, 0];
  const last = stroke.points[stroke.points.length - 1] ?? first;
  const kind = stroke.tool === "rect" ? "Rect" : "Arrow";
  return {
    kind,
    from: toFraction({ x: first[0], y: first[1] }, box),
    to: toFraction({ x: last[0], y: last[1] }, box),
  };
}
