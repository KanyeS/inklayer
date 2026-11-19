/** Small DOM helpers for the demo scripts. `h` and `followColorScheme` are shared with the extension (@inklayer/overlay). */

export { followColorScheme, h } from "@inklayer/overlay";

/** The element matching `selector`; throws if the page doesn't have it, so a typo fails loudly. */
export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** A Range over the first occurrence of `phrase` in one of root's text nodes. */
export function textRange(root: Node, phrase: string): Range {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(phrase);
    if (at >= 0) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + phrase.length);
      return range;
    }
  }
  throw new Error(`"${phrase}" isn't in the page`);
}

/** Restarts a CSS animation by toggling its class. */
export function replay(el: Element, className: string): void {
  el.classList.remove(className);
  void el.getBoundingClientRect();
  el.classList.add(className);
}
