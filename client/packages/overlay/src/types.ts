/** Shared model between the overlay (inside the captured page) and the viewer (the app). */

export type AnnotationKind = "Pin" | "Element" | "Highlight" | "Rect" | "Arrow" | "Ink";
export type Tool = "select" | "pin" | "element" | "highlight" | "rect" | "arrow" | "ink";

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Several independent ways to find the same element again. They're tried in order. */
export interface ElementAnchor {
  /** One CSS selector per scope, outermost first; each later segment is resolved inside the previous match's shadow root. */
  path: string[];
  /** Absolute XPath (light DOM only), used when the CSS path no longer matches. */
  xpath: string | null;
  tag: string;
  /** The element's normalised text (first 120 characters), used for fuzzy re-matching. */
  text: string;
  /** Where the element was, in document pixels, when the annotation was made (used for orphaned annotations). */
  box: Box;
}

/** A W3C Web Annotation style text selector, relative to the anchor element's text. */
export interface TextAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export interface Anchor {
  element: ElementAnchor;
  text?: TextAnchor;
}

/**
 * Shape coordinates are fractions of the anchor element's box ({x:0,y:0} = its top-left, {x:1,y:1} = its bottom-right),
 * so marks follow the element when the layout changes. They may go outside 0..1.
 */
export type Geometry =
  | { kind: "Pin"; point: Point }
  | { kind: "Element" }
  | { kind: "Highlight" }
  | { kind: "Rect"; from: Point; to: Point }
  | { kind: "Arrow"; from: Point; to: Point }
  | { kind: "Ink"; points: [number, number, number][]; size: number };

export interface OverlayAnnotation {
  id: string;
  kind: AnnotationKind;
  color: string;
  resolved: boolean;
  /** Number shown in the badge (matches the viewer's list). */
  label: number;
  anchor: Anchor;
  geometry: Geometry;
}

export interface Draft {
  kind: AnnotationKind;
  anchor: Anchor;
  geometry: Geometry;
  viewportWidth: number;
}

export type AnchorQuality = "exact" | "fallback" | "orphaned";

/** Messages from the viewer to the overlay. */
export type HostMessage =
  | { type: "setAnnotations"; annotations: OverlayAnnotation[] }
  | { type: "setTool"; tool: Tool; color: string }
  | { type: "select"; id: string | null; scroll: boolean }
  | { type: "clearDraft" }
  | { type: "scrollTo"; x: number; y: number };

/** Messages from the overlay to the viewer. */
export type OverlayMessage =
  | { type: "ready"; width: number; height: number }
  | { type: "draft"; draft: Draft }
  | { type: "selected"; id: string | null }
  | { type: "anchors"; quality: Record<string, AnchorQuality> };

export const PROTOCOL = "inklayer-overlay";
export const PROTOCOL_VERSION = 1;

export interface Envelope<T> {
  protocol: typeof PROTOCOL;
  version: typeof PROTOCOL_VERSION;
  message: T;
}
