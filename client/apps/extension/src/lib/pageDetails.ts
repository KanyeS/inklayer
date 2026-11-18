/**
 * Page details captured with a comment for bug reports: browser, OS, the element, and the screenshot area. No chrome.*
 * APIs here, so it can be used by the content script and tested on its own.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_WIDTH = 480;
const MIN_HEIGHT = 300;
const MARGIN = 80;
const MAX_HTML = 8 * 1024;

/**
 * The part of the visible window to screenshot: the commented area plus a margin, at least a readable size, kept inside
 * the window. In CSS pixels; multiply by the device pixel ratio for the captured image.
 */
export function screenshotArea(target: Rect, viewport: { width: number; height: number }): Rect {
  const width = Math.min(viewport.width, Math.max(MIN_WIDTH, target.width + 2 * MARGIN));
  const height = Math.min(viewport.height, Math.max(MIN_HEIGHT, target.height + 2 * MARGIN));
  const centreX = target.x + target.width / 2;
  const centreY = target.y + target.height / 2;
  const x = Math.min(Math.max(0, centreX - width / 2), viewport.width - width);
  const y = Math.min(Math.max(0, centreY - height / 2), viewport.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export function browserOf(userAgent: string): string {
  const version = (name: string) => new RegExp(`${name}/(\\d+)`).exec(userAgent)?.[1];
  if (version("Edg")) return `Edge ${version("Edg")}`;
  if (version("OPR")) return `Opera ${version("OPR")}`;
  if (version("Firefox")) return `Firefox ${version("Firefox")}`;
  if (version("Chrome")) return `Chrome ${version("Chrome")}`;
  if (version("Version") && /Safari/.test(userAgent)) return `Safari ${version("Version")}`;
  return "Unknown browser";
}

export function osOf(userAgent: string): string {
  if (/Windows NT/.test(userAgent)) return "Windows";
  if (/iPhone|iPad/.test(userAgent)) return "iOS";
  if (/Android/.test(userAgent)) return "Android";
  if (/CrOS/.test(userAgent)) return "ChromeOS";
  if (/Mac OS X/.test(userAgent)) return "macOS";
  if (/Linux/.test(userAgent)) return "Linux";
  return "Unknown OS";
}

/**
 * The element's HTML for a bug report, without anything typed into forms (input values, textarea text, selected options)
 * or scripts and styles, cut to 8 KB.
 */
export function elementHtml(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    const tag = node.localName;
    if (tag === "script" || tag === "style" || tag === "noscript") {
      node.replaceChildren();
      continue;
    }
    if (tag === "input" || tag === "textarea" || tag === "select" || tag === "option") {
      node.removeAttribute("value");
      node.removeAttribute("selected");
      if (tag === "textarea") node.textContent = "";
    }
  }
  const html = copy.outerHTML;
  return html.length > MAX_HTML ? `${html.slice(0, MAX_HTML - 1)}…` : html;
}
