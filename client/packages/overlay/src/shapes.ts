import { getStroke } from "perfect-freehand";
import { fromFraction, normaliseRect } from "./geometry";
import type { Box, Geometry, Point } from "./types";

/**
 * The SVG for each kind of mark (outlines, highlights, boxes, arrows, ink) and where its number badge goes. Shapes are
 * built as DOM in document coordinates; `svgPath` and `badgeAnchor` are pure and unit-tested in test/shapes.test.ts.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";
/** The pen width of freehand ink, in pixels. */
export const INK_SIZE = 6;
const ARROWHEAD_SIZE = 14;

/** A point of a freehand stroke: x, y and pen pressure (0.5 when the device has none). */
export type StrokePoint = [number, number, number];

function svg<K extends keyof SVGElementTagNameMap>(
  doc: Document,
  tag: K,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = doc.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, String(value));
  return el;
}

/** A rounded rectangle: an element's outline, a highlighted line of text, or a drawn box. */
export function rect(doc: Document, box: Box, className: string): SVGRectElement {
  return svg(doc, "rect", {
    class: className,
    x: box.x,
    y: box.y,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
    rx: className === "highlight" ? 2 : 4,
  });
}

/** The arrowhead's three corners, pointing at `to`. */
export function arrowheadPoints(from: Point, to: Point, size = ARROWHEAD_SIZE): [number, number][] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const corner = (turn: number): [number, number] => [
    to.x - size * Math.cos(angle + turn),
    to.y - size * Math.sin(angle + turn),
  ];
  return [[to.x, to.y], corner(-Math.PI / 7), corner(Math.PI / 7)];
}

export function arrow(doc: Document, from: Point, to: Point): SVGGElement {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  // The shaft stops inside the head: run to the tip, its thick round end would stick out past the head's narrow point.
  const shaft = Math.min(ARROWHEAD_SIZE * 0.6, Math.hypot(to.x - from.x, to.y - from.y));
  const line = svg(doc, "line", {
    class: "arrow",
    x1: from.x,
    y1: from.y,
    x2: to.x - shaft * Math.cos(angle),
    y2: to.y - shaft * Math.sin(angle),
  });
  const head = svg(doc, "polygon", {
    class: "arrowhead",
    points: arrowheadPoints(from, to)
      .map((p) => p.join(","))
      .join(" "),
  });
  const g = svg(doc, "g", {});
  g.append(line, head);
  return g;
}

/** A freehand stroke, thinner and thicker with pen pressure (simulated when the device reports none). */
export function ink(doc: Document, points: StrokePoint[], size: number): SVGPathElement {
  const outline = getStroke(points, {
    size,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: points.every((p) => p[2] === 0.5),
  });
  return svg(doc, "path", { class: "ink", d: svgPath(outline) });
}

/** perfect-freehand's outline -> a smooth SVG path (quadratic curves through midpoints). */
export function svgPath(outline: number[][]): string {
  const [start] = outline;
  if (!start || outline.length < 2) return "";
  const f = (n: number | undefined) => (n ?? 0).toFixed(1);
  let d = `M${f(start[0])},${f(start[1])} Q`;
  outline.forEach((p, i) => {
    const next = outline[(i + 1) % outline.length] ?? p;
    d += `${f(p[0])},${f(p[1])} ${f(((p[0] ?? 0) + (next[0] ?? 0)) / 2)},${f(((p[1] ?? 0) + (next[1] ?? 0)) / 2)} `;
  });
  return `${d}Z`;
}

/** A range's line boxes in document coordinates (one per line of highlighted text). */
export function rangeBoxes(doc: Document, range: Range): Box[] {
  const win = doc.defaultView;
  const scrollX = win?.scrollX ?? 0;
  const scrollY = win?.scrollY ?? 0;
  return Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => ({ x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }));
}

/** Ink points stored as fractions of the anchor's box, back in document coordinates. */
function inkPoints(points: StrokePoint[], box: Box): StrokePoint[] {
  return points.map(([x, y, p]) => {
    const pt = fromFraction({ x, y }, box);
    return [pt.x, pt.y, p];
  });
}

/**
 * Where a mark's number badge goes: a pin's point, the start of a box, arrow or stroke, the first highlighted line, or
 * otherwise the anchor's top-left corner.
 */
export function badgeAnchor(geometry: Geometry, box: Box, highlightBoxes: Box[] | null = null): Point {
  switch (geometry.kind) {
    case "Pin":
      return fromFraction(geometry.point, box);
    case "Highlight": {
      const first = highlightBoxes?.[0];
      return first ? { x: first.x, y: first.y } : { x: box.x, y: box.y };
    }
    case "Rect": {
      const r = normaliseRect(fromFraction(geometry.from, box), fromFraction(geometry.to, box));
      return { x: r.x, y: r.y };
    }
    case "Arrow":
      return fromFraction(geometry.from, box);
    case "Ink": {
      const first = geometry.points[0];
      return first ? fromFraction({ x: first[0], y: first[1] }, box) : { x: box.x, y: box.y };
    }
    case "Element":
      return { x: box.x, y: box.y };
  }
}

/**
 * A mark's shapes, for an annotation anchored to `box`. For highlights, `highlightBoxes` are the text's line boxes, or
 * null when the text wasn't found (the whole element is highlighted instead).
 */
export function markShapes(doc: Document, geometry: Geometry, box: Box, highlightBoxes: Box[] | null): SVGElement[] {
  switch (geometry.kind) {
    case "Pin":
      return []; // just the badge
    case "Element":
      return [rect(doc, box, "outline")];
    case "Highlight":
      return (highlightBoxes ?? [box]).map((r) => rect(doc, r, "highlight"));
    case "Rect":
      return [rect(doc, normaliseRect(fromFraction(geometry.from, box), fromFraction(geometry.to, box)), "rect")];
    case "Arrow":
      return [arrow(doc, fromFraction(geometry.from, box), fromFraction(geometry.to, box))];
    case "Ink":
      return [ink(doc, inkPoints(geometry.points, box), geometry.size)];
  }
}
