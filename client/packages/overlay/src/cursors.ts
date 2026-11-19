import { anchorFor, resolveElement, scopedSelectorPath } from "./anchoring";
import type { Anchor, ElementAnchor } from "./types";

/**
 * Where people's pointers and selections are, as they travel between browsers. Positions are anchors, not screen
 * coordinates, so a cursor over a paragraph stays over that paragraph on a screen of a different size: the element
 * under the pointer (its selector path) plus the fractions across its box. If the element can't be found on this page,
 * the document position (relative to the page width) is used instead.
 */

/** Where someone's pointer is. */
export interface CursorPosition {
  /** The element under the pointer, by selector path (one selector per shadow scope) and tag. */
  a?: { path: string[]; tag: string };
  /** Fractions across and down that element's box. */
  fx?: number;
  fy?: number;
  /** Fallback: the document position, both as fractions of the page width. */
  dx: number;
  dy: number;
}

export interface DocPoint {
  x: number;
  y: number;
}

/** Selections bigger than this (as JSON) aren't shared. */
const MAX_SELECTION_JSON = 12_000;
/** How far a drawn cursor moves towards its target each frame, so it glides rather than jumps. */
const SMOOTHING = 0.35;
/** A target further than this away is jumped to rather than glided to (e.g. after scrolling far). */
const JUMP_DISTANCE_PX = 3000;
/** Closer than this, the cursor is there. */
const ARRIVED_PX = 0.5;

const pathCache = new WeakMap<Element, string[]>();

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** The pointer's position as an anchor. `ignore` skips Inklayer's own elements. */
export function cursorPositionAt(
  doc: Document,
  clientX: number,
  clientY: number,
  ignore?: (el: Element) => boolean,
): CursorPosition {
  const win = doc.defaultView;
  const width = Math.max(1, doc.documentElement.scrollWidth);
  const position: CursorPosition = {
    dx: round((clientX + (win?.scrollX ?? 0)) / width),
    dy: round((clientY + (win?.scrollY ?? 0)) / width),
  };
  const el = doc.elementFromPoint(clientX, clientY);
  if (!el || el === doc.documentElement || ignore?.(el)) return position;

  let path = pathCache.get(el);
  if (!path) {
    path = scopedSelectorPath(el);
    pathCache.set(el, path);
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return position;
  return {
    ...position,
    a: { path, tag: el.localName },
    fx: round((clientX - rect.left) / rect.width),
    fy: round((clientY - rect.top) / rect.height),
  };
}

/** The current selection as an anchor, or null if nothing (or too much) is selected. */
export function selectionAnchor(doc: Document, ignore?: (el: Element) => boolean): Anchor | null {
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const root = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement;
  if (!root || ignore?.(root)) return null;
  const anchor = anchorFor(root, range);
  if (!anchor.text) return null;
  return JSON.stringify(anchor).length > MAX_SELECTION_JSON ? null : anchor;
}

/** Whether a value received from someone else is a well-formed cursor position (it came over the network). */
export function isCursorPosition(value: unknown): value is CursorPosition {
  const p = value as CursorPosition | null;
  if (!p || typeof p !== "object" || !Number.isFinite(p.dx) || !Number.isFinite(p.dy)) return false;
  if (p.a === undefined) return true;
  return (
    Array.isArray(p.a.path) &&
    p.a.path.every((s) => typeof s === "string") &&
    typeof p.a.tag === "string" &&
    Number.isFinite(p.fx) &&
    Number.isFinite(p.fy)
  );
}

/** A key that changes when a position refers to a different element. */
export function elementKeyOf(position: CursorPosition): string {
  return position.a ? position.a.path.join("\u0000") : "";
}

/** The element a cursor position refers to on this page, or null if it isn't here. */
export function findCursorElement(doc: Document, position: CursorPosition): Element | null {
  if (!position.a) return null;
  const anchor: ElementAnchor = {
    path: position.a.path,
    xpath: null,
    tag: position.a.tag,
    text: "",
    box: { x: 0, y: 0, width: 0, height: 0 },
  };
  return resolveElement(doc, anchor).element;
}

/**
 * Where to draw a cursor, in document coordinates: at the same fractions of the same element's box, or, if the element
 * isn't on this page (or has no size), at the same document position relative to the page width.
 */
export function placeCursor(
  doc: Document,
  position: CursorPosition,
  element: Element | null = findCursorElement(doc, position),
): DocPoint {
  if (element && position.fx !== undefined && position.fy !== undefined) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      const win = doc.defaultView;
      return {
        x: rect.left + position.fx * rect.width + (win?.scrollX ?? 0),
        y: rect.top + position.fy * rect.height + (win?.scrollY ?? 0),
      };
    }
  }
  const width = Math.max(1, doc.documentElement.scrollWidth);
  return { x: position.dx * width, y: position.dy * width };
}

/**
 * One frame of a cursor gliding towards its target: where it's drawn next, and whether it's still on its way. It
 * starts at (or jumps to) the target when it has no position yet or the target is far away.
 */
export function glide(at: DocPoint | null, target: DocPoint): { at: DocPoint; moving: boolean } {
  if (!at || Math.hypot(target.x - at.x, target.y - at.y) > JUMP_DISTANCE_PX)
    return { at: { ...target }, moving: false };
  const next = { x: at.x + (target.x - at.x) * SMOOTHING, y: at.y + (target.y - at.y) * SMOOTHING };
  const moving = Math.abs(target.x - next.x) > ARRIVED_PX || Math.abs(target.y - next.y) > ARRIVED_PX;
  return moving ? { at: next, moving } : { at: { ...target }, moving };
}
