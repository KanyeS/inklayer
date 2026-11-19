import { type Anchor, type AnnotationKind, anchorFor, type Geometry, type Point } from "@inklayer/overlay";
import { textRange } from "./dom";
import type { Person } from "./people";

/** The demo's comments, and the marks they point at, in the same shapes the extension saves. */

/** What a comment points at. */
export interface Mark {
  kind: AnnotationKind;
  anchor: Anchor;
  geometry: Geometry;
}

export interface Reply {
  person: Person;
  body: string;
  time: string;
}

export interface Comment extends Mark {
  id: string;
  label: number;
  person: Person;
  body: string;
  time: string;
  resolved: boolean;
  replies: Reply[];
  /** Still being drawn or written: shown as a mark, but without a card. */
  draft: boolean;
}

/** The pen width demo ink is drawn with, as the extension's ink tool does. */
const INK_SIZE = 6;

/** Marks built the way the extension builds them: anchors from the real anchoring code, shapes as fractions of the element. */
export const marks = {
  /** A pin at a point on the element, as fractions of its box. */
  pin: (el: Element, x = 0.5, y = 0.5): Mark => ({
    kind: "Pin",
    anchor: anchorFor(el),
    geometry: { kind: "Pin", point: { x, y } },
  }),
  /** The whole element, outlined. */
  element: (el: Element): Mark => ({ kind: "Element", anchor: anchorFor(el), geometry: { kind: "Element" } }),
  /** A phrase inside the element, highlighted. */
  highlight: (el: Element, phrase: string): Mark => ({
    kind: "Highlight",
    anchor: anchorFor(el, textRange(el, phrase)),
    geometry: { kind: "Highlight" },
  }),
  rect: (el: Element, from: Point, to: Point): Mark => ({
    kind: "Rect",
    anchor: anchorFor(el),
    geometry: { kind: "Rect", from, to },
  }),
  arrow: (el: Element, from: Point, to: Point): Mark => ({
    kind: "Arrow",
    anchor: anchorFor(el),
    geometry: { kind: "Arrow", from, to },
  }),
  /** Freehand ink through points given as fractions of the element. */
  ink: (el: Element, points: Point[]): Mark => ({
    kind: "Ink",
    anchor: anchorFor(el),
    geometry: { kind: "Ink", size: INK_SIZE, points: points.map((p) => [p.x, p.y, 0.5]) },
  }),
};
