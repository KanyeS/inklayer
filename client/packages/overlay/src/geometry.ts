import type { Box, Point } from "./types";

/** Document point -> fraction of the box. Zero-sized boxes fall back to pixel offsets. */
export function toFraction(point: Point, box: Box): Point {
  return {
    x: box.width > 0 ? (point.x - box.x) / box.width : point.x - box.x,
    y: box.height > 0 ? (point.y - box.y) / box.height : point.y - box.y,
  };
}

/** Fraction of the box -> document point (inverse of {@link toFraction}). */
export function fromFraction(fraction: Point, box: Box): Point {
  return {
    x: box.x + (box.width > 0 ? fraction.x * box.width : fraction.x),
    y: box.y + (box.height > 0 ? fraction.y * box.height : fraction.y),
  };
}

export function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function boundsOf(points: Point[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function normaliseRect(a: Point, b: Point): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}
