import type { Anchor, AnchorQuality, Box, ElementAnchor, TextAnchor } from "./types";

const TEST_ID_ATTRIBUTES = ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy"];
const MAX_FUZZY_CANDIDATES = 5000;
const CONTEXT_LENGTH = 32;

/* ------------------------------------------------------------------ element anchors */

export function describeElement(el: Element): ElementAnchor {
  return {
    path: scopedSelectorPath(el),
    xpath: "host" in el.getRootNode() ? null : xpathFor(el),
    tag: el.localName,
    text: normaliseText(el.textContent ?? "").slice(0, 120),
    box: documentBox(el),
  };
}

/**
 * Finds the anchored element again. Each anchor is tried in turn, and the result says how reliable the match is:
 * the CSS path (`exact`); the XPath or a unique text match (`fallback`); otherwise null (`orphaned`).
 */
export function resolveElement(doc: Document, anchor: ElementAnchor): { element: Element | null; quality: AnchorQuality } {
  const byPath = resolvePath(doc, anchor.path);
  if (byPath && matchesTag(byPath, anchor)) return { element: byPath, quality: "exact" };

  if (anchor.xpath) {
    const byXPath = evaluateXPath(doc, anchor.xpath);
    if (byXPath && matchesTag(byXPath, anchor) && textSimilar(byXPath, anchor)) return { element: byXPath, quality: "fallback" };
  }

  if (anchor.text.length >= 3) {
    const candidates = Array.from(doc.getElementsByTagName(anchor.tag)).slice(0, MAX_FUZZY_CANDIDATES);
    const matches = candidates.filter((c) => normaliseText(c.textContent ?? "").slice(0, 120) === anchor.text);
    if (matches.length === 1) return { element: matches[0]!, quality: "fallback" };
    if (matches.length > 1) {
      // Several elements have the same text; take the one closest to where the original was.
      const closest = matches.map((m) => ({ m, d: distance(documentBox(m), anchor.box) })).sort((a, b) => a.d - b.d)[0]!;
      return { element: closest.m, quality: "fallback" };
    }
  }

  // Path matched, but the tag changed: still better than nothing.
  if (byPath) return { element: byPath, quality: "fallback" };
  return { element: null, quality: "orphaned" };
}

function matchesTag(el: Element, anchor: ElementAnchor): boolean {
  return el.localName === anchor.tag;
}

function textSimilar(el: Element, anchor: ElementAnchor): boolean {
  if (!anchor.text) return true;
  const text = normaliseText(el.textContent ?? "").slice(0, 120);
  return text === anchor.text || text.startsWith(anchor.text.slice(0, 20));
}

function resolvePath(doc: Document, path: string[]): Element | null {
  let scope: Document | ShadowRoot = doc;
  let el: Element | null = null;
  for (let i = 0; i < path.length; i++) {
    try {
      el = scope.querySelector(path[i]!);
    } catch {
      return null;
    }
    if (!el) return null;
    if (i < path.length - 1) {
      if (!el.shadowRoot) return null;
      scope = el.shadowRoot;
    }
  }
  return el;
}

/** One selector per scope (document, then each shadow root on the way down), each unique within its scope. */
export function scopedSelectorPath(el: Element): string[] {
  const path: string[] = [];
  let current: Element | null = el;
  while (current) {
    const root = current.getRootNode() as Document | ShadowRoot;
    path.unshift(uniqueSelector(current, root));
    current = "host" in root ? (root as ShadowRoot).host : null;
  }
  return path;
}

/**
 * A short CSS selector that matches exactly this element within its scope. It prefers a stable id or a test attribute,
 * and otherwise builds a child path anchored at the nearest ancestor that has one.
 */
export function uniqueSelector(el: Element, root: Document | ShadowRoot): string {
  const direct = stableHandle(el, root);
  if (direct) return direct;

  const segments: string[] = [];
  let current: Element | null = el;
  while (current && current.parentNode !== root && current.parentElement) {
    const handle = stableHandle(current, root);
    if (handle) {
      segments.unshift(handle);
      return segments.join(" > ");
    }
    segments.unshift(segment(current));
    current = current.parentElement;
  }
  if (current) segments.unshift(segment(current));
  return segments.join(" > ");
}

function stableHandle(el: Element, root: Document | ShadowRoot): string | null {
  const id = el.getAttribute("id");
  if (id && isStableId(id)) {
    const selector = `#${cssEscape(id)}`;
    if (countMatches(root, selector) === 1) return selector;
  }
  for (const attribute of TEST_ID_ATTRIBUTES) {
    const value = el.getAttribute(attribute);
    if (value) {
      const selector = `${el.localName}[${attribute}="${cssEscapeString(value)}"]`;
      if (countMatches(root, selector) === 1) return selector;
    }
  }
  return null;
}

function segment(el: Element): string {
  const tag = cssEscape(el.localName);
  const parent = el.parentElement;
  if (!parent) return tag;
  const sameTag = Array.from(parent.children).filter((c) => c.localName === el.localName);
  return sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(el) + 1})`;
}

/** Framework-generated ids (React's :r1:, Ember's ember123, long hashes, numbered ids) change between page loads. */
export function isStableId(id: string): boolean {
  return !/^:|^ember\d|^react-|^radix-|^headlessui-|^mui-|\d{3,}|[a-f0-9]{8,}|__/i.test(id);
}

function countMatches(root: Document | ShadowRoot, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

export function xpathFor(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current.nodeType === 1) {
    const parent: Element | null = current.parentElement;
    const name = current.localName;
    if (!parent) {
      parts.unshift(`/${name}`);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.localName === name);
    parts.unshift(sameTag.length === 1 ? `/${name}` : `/${name}[${sameTag.indexOf(current) + 1}]`);
    current = parent;
  }
  return parts.join("");
}

function evaluateXPath(doc: Document, xpath: string): Element | null {
  try {
    const node = doc.evaluate(xpath, doc, null, 9 /* FIRST_ORDERED_NODE_TYPE */, null).singleNodeValue;
    return node && node.nodeType === 1 ? (node as Element) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ text anchors */

/** Describes a text range relative to `root`'s text, with surrounding context for re-matching. */
export function describeRange(range: Range, root: Element): TextAnchor | null {
  const { text, nodes } = textIndex(root);
  const start = offsetOf(nodes, range.startContainer, range.startOffset);
  const end = offsetOf(nodes, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(end, end + CONTEXT_LENGTH),
    start,
    end,
  };
}

/**
 * Finds the text again inside `root`. It tries the stored position first. If the text moved, it picks the occurrence
 * whose surrounding context best matches the prefix and suffix.
 */
export function resolveRange(root: Element, anchor: TextAnchor): { range: Range | null; quality: AnchorQuality } {
  const { text, nodes } = textIndex(root);
  if (text.slice(anchor.start, anchor.end) === anchor.exact) {
    return { range: rangeFor(root.ownerDocument, nodes, anchor.start, anchor.end), quality: "exact" };
  }

  let best: { start: number; score: number } | null = null;
  for (let i = text.indexOf(anchor.exact); i >= 0; i = text.indexOf(anchor.exact, i + 1)) {
    const score = commonSuffix(text.slice(Math.max(0, i - anchor.prefix.length), i), anchor.prefix)
      + commonPrefix(text.slice(i + anchor.exact.length, i + anchor.exact.length + anchor.suffix.length), anchor.suffix)
      - Math.abs(i - anchor.start) / 10_000;
    if (!best || score > best.score) best = { start: i, score };
  }
  if (!best) return { range: null, quality: "orphaned" };
  return { range: rangeFor(root.ownerDocument, nodes, best.start, best.start + anchor.exact.length), quality: "fallback" };
}

interface IndexedText {
  node: Text;
  start: number;
}

function textIndex(root: Element): { text: string; nodes: IndexedText[] } {
  const walker = root.ownerDocument.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const nodes: IndexedText[] = [];
  let text = "";
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    nodes.push({ node, start: text.length });
    text += node.data;
  }
  return { text, nodes };
}

function offsetOf(nodes: IndexedText[], container: Node, offset: number): number | null {
  if (container.nodeType === 3) {
    const entry = nodes.find((n) => n.node === container);
    return entry ? entry.start + offset : null;
  }
  // Element boundary: offset counts child nodes. Use the first text node at or after that child.
  const child = container.childNodes[offset];
  const after = child ? nodes.find((n) => child === n.node || child.contains(n.node)) : null;
  if (after) return after.start;
  const before = [...nodes].reverse().find((n) => container.contains(n.node));
  return before ? before.start + before.node.data.length : null;
}

function rangeFor(doc: Document, nodes: IndexedText[], start: number, end: number): Range | null {
  const locate = (offset: number, preferEnd: boolean) => {
    for (const entry of nodes) {
      const length = entry.node.data.length;
      const within = preferEnd ? offset > entry.start && offset <= entry.start + length : offset >= entry.start && offset < entry.start + length;
      if (within) return { node: entry.node, offset: offset - entry.start };
    }
    return null;
  };
  const from = locate(start, false);
  const to = locate(end, true);
  if (!from || !to) return null;
  const range = doc.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/* ------------------------------------------------------------------ helpers */

export function anchorFor(el: Element, range?: Range): Anchor {
  const anchor: Anchor = { element: describeElement(el) };
  if (range) {
    const text = describeRange(range, el);
    if (text) anchor.text = text;
  }
  return anchor;
}

/** The element's border box in document coordinates (CSS pixels from the top-left of the page). */
export function documentBox(el: Element): Box {
  const rect = el.getBoundingClientRect();
  const win = el.ownerDocument.defaultView;
  return { x: rect.left + (win?.scrollX ?? 0), y: rect.top + (win?.scrollY ?? 0), width: rect.width, height: rect.height };
}

/**
 * Where an element's padding box starts, in document coordinates: the origin of anything absolutely positioned inside it.
 * Layers drawn `within` an element use it to turn document coordinates into the element's own.
 */
export function innerOrigin(el: HTMLElement): { x: number; y: number } {
  const box = documentBox(el);
  return { x: box.x + el.clientLeft - el.scrollLeft, y: box.y + el.clientTop - el.scrollTop };
}

function distance(a: Box, b: Box): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function normaliseText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function cssEscape(value: string): string {
  return value.replace(/^(-?\d)/, "\\3$1 ").replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function cssEscapeString(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
