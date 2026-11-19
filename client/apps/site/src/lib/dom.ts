/** Small DOM helpers for the demo scripts. */

/** The element matching `selector`; throws if the page doesn't have it, so a typo fails loudly. */
export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

type Child = Node | string | null | undefined | false;
type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style">> & {
  style?: Record<string, string>;
};

/** Creates an element: `h("span", { className: "badge", style: { "--c": color } }, "4")`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(el, rest);
  for (const [name, value] of Object.entries(style ?? {})) el.style.setProperty(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
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

/** Applies the theme's dark palette to a shadow host (tokens live under :host(.dark)), following the system setting. */
export function followColorScheme(el: HTMLElement): void {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => el.classList.toggle("dark", dark.matches);
  apply();
  dark.addEventListener("change", apply);
}
