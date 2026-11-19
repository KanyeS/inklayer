/**
 * Small DOM helpers shared by everything that builds UI without React: the extension's on-page panel and the showcase
 * site's demos. Everything here builds DOM nodes directly and never parses HTML.
 */

/** Something `h` can append: falsy values are skipped, so `cond && h(...)` works as a child. */
export type Child = Node | string | null | undefined | false;

/** An element's own properties (className, title, onclick…), plus `style` as a map of CSS properties to values. */
export type Props<K extends keyof HTMLElementTagNameMap> = Partial<Omit<HTMLElementTagNameMap[K], "style">> & {
  style?: Record<string, string>;
};

/**
 * Creates an element, sets its properties and appends its children:
 * `h("span", { className: "badge", style: { background: color } }, "4")`.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { style, ...rest } = props;
  Object.assign(el, rest);
  for (const [name, value] of Object.entries(style ?? {})) el.style.setProperty(name, value);
  for (const child of children) if (child) el.append(child);
  return el;
}

/** An empty node, for a part of a view that has nothing to show. */
export function nothing(): Text {
  return document.createTextNode("");
}

/** An event handler that stops a click from also reaching the element underneath (e.g. a list item that selects). */
export function stopPropagation(e: Event): void {
  e.stopPropagation();
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A line icon from SVG path data (Lucide's 24×24 grid), drawn in the current text colour. */
export function lineIcon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attributes: Record<string, string> = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/**
 * Applies the theme's dark palette to a shadow host (tokens live under `:host(.dark)`), following the system setting
 * like the viewer and popup do.
 */
export function followColorScheme(host: HTMLElement): void {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => host.classList.toggle("dark", dark.matches);
  apply();
  dark.addEventListener("change", apply);
}

/**
 * The theme's colour tokens (`tokens.css`, written for a whole page) rewritten for a shadow root: `:root` becomes
 * `:host` and `.dark` becomes `:host(.dark)`. Comments are dropped.
 */
export function shadowTokens(tokensCss: string): string {
  return tokensCss
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/:root/g, ":host")
    .replace(/\.dark\b/g, ":host(.dark)");
}

/** Copies text. Pages without a secure context can't use the clipboard API, so this falls back to the old way. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
