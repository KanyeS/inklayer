import {
  browserOf,
  type Draft,
  elementHtml,
  osOf,
  type Rect,
  resolveElement,
  resolveRange,
  screenshotArea,
} from "@inklayer/overlay";
import type { PageContext } from "../lib/live";

import { call, messageOf } from "./call";
import { nextPaint, pageLogs } from "./page-io";

/**
 * Bug context for a new comment: a screenshot of the commented area, plus the page details (browser, window size, the
 * element, recent console errors and failed requests). Best effort: the comment is already saved whatever happens here.
 */

/** The part of the window a draft is about: its text, its element, or the middle of the window if neither is found. */
function draftArea(draft: Draft): { element: Element | null; area: Rect } {
  const element = resolveElement(document, draft.anchor.element).element;
  const range = element && draft.anchor.text ? resolveRange(element, draft.anchor.text).range : null;
  const box = range?.getBoundingClientRect() ?? element?.getBoundingClientRect() ?? null;
  const area: Rect = box
    ? { x: box.left, y: box.top, width: box.width, height: box.height }
    : { x: innerWidth / 2, y: innerHeight / 2, width: 0, height: 0 };
  return { element, area };
}

async function pageContext(draft: Draft, element: Element | null): Promise<PageContext> {
  return {
    browser: browserOf(navigator.userAgent),
    os: osOf(navigator.userAgent),
    userAgent: navigator.userAgent,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    devicePixelRatio: devicePixelRatio,
    selector: draft.anchor.element.path.join(" >>> "),
    elementHtml: element ? elementHtml(element) : "",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
    scripts: pageScripts(),
    ...(await pageLogs()),
  };
}

/** Most build names sent. */
const MAX_SCRIPTS = 4;
/** A built file's name: it has a content hash in it, like main.3f2a9c1e.js or chunk-AB12CD34.js (with a digit). */
const HASHED = /[.\-_~](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}\.m?js$/;

/**
 * The page's build: the names of its built script files (no addresses or queries), which are the same for everyone until
 * the site deploys a new build, and a Next.js site's build id. Other scripts say nothing about the build and are left out.
 */
export function pageScripts(doc: Document = document): string[] {
  const names = [...doc.scripts]
    .map((s) => {
      try {
        return new URL(s.src).pathname.split("/").pop() ?? "";
      } catch {
        return "";
      }
    })
    .filter((name) => name.length > 0);
  const built = [...new Set(names)].filter((n) => HASHED.test(n));
  try {
    const next = JSON.parse(doc.getElementById("__NEXT_DATA__")?.textContent ?? "null") as { buildId?: unknown } | null;
    if (typeof next?.buildId === "string") built.unshift(`next build ${next.buildId}`);
  } catch {
    // Not a Next.js page, or not its data.
  }
  return built.slice(0, MAX_SCRIPTS);
}

/** Takes the screenshot with `hide` (Inklayer's own panel and bubbles) hidden, so it shows the page and the marks only. */
async function captureWithout(hide: HTMLElement[], annotationId: string, area: Rect): Promise<void> {
  for (const el of hide) el.style.visibility = "hidden";
  try {
    await nextPaint();
    const visible = screenshotArea(area, { width: innerWidth, height: innerHeight });
    await call({ type: "live.capture", annotationId, area: visible, viewportWidth: innerWidth });
  } finally {
    for (const el of hide) el.style.visibility = "";
  }
}

/**
 * Attaches the page details and a screenshot to a just-saved comment. Returns null once the screenshot is uploaded (so
 * the comment can be reloaded to show it), or a note saying why there's no screenshot.
 */
export async function attachPageDetails(
  annotationId: string,
  draft: Draft,
  hide: HTMLElement[],
): Promise<string | null> {
  const { element, area } = draftArea(draft);
  const context = await pageContext(draft, element);
  await call({ type: "live.context", annotationId, context }).catch(() => undefined);

  try {
    await captureWithout(hide, annotationId, area);
  } catch (e) {
    return `No screenshot: ${messageOf(e)}`;
  }
  // Uploaded in the background; wait for it.
  try {
    await call({ type: "live.captureResult", annotationId });
    return null;
  } catch (e) {
    return `The screenshot didn't upload: ${messageOf(e)}`;
  }
}

/** Most elements looked at for fixed and sticky ones, on very large pages. */
const MAX_ELEMENTS_CHECKED = 20_000;

/** Hides the page's fixed and sticky elements (headers, chat buttons), so they don't repeat down a full-page screenshot. */
function hideFixed(except: HTMLElement[]): () => void {
  const hidden: { el: HTMLElement; visibility: string }[] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_ELEMENT);
  for (let n = 0, node = walker.nextNode(); node && n < MAX_ELEMENTS_CHECKED; n++, node = walker.nextNode()) {
    const el = node as HTMLElement;
    if (except.includes(el) || !el.style) continue;
    const position = getComputedStyle(el).position;
    if (position === "fixed" || position === "sticky") {
      hidden.push({ el, visibility: el.style.visibility });
      el.style.visibility = "hidden";
    }
  }
  return () => {
    for (const { el, visibility } of hidden) el.style.visibility = visibility;
  };
}

/**
 * Takes a screenshot of the whole page, top to bottom, for a just-saved comment: scrolls through it a screen at a time
 * (Inklayer's own panel hidden, and the page's fixed headers after the first screen), then puts the page back as it was.
 * Returns null once it's uploaded, or a note saying why there isn't one.
 */
export async function attachFullPage(annotationId: string, hide: HTMLElement[]): Promise<string | null> {
  const page = document.scrollingElement ?? document.documentElement;
  const total = Math.max(page.scrollHeight, document.body?.scrollHeight ?? 0, innerHeight);
  const start = { left: scrollX, top: scrollY };
  let showFixed: (() => void) | null = null;
  for (const el of hide) el.style.visibility = "hidden";
  try {
    const { height } = await call<{ height: number }>({
      type: "live.fullPageStart",
      annotationId,
      width: innerWidth,
      height: total,
    });
    for (let y = 0; ; y += innerHeight) {
      window.scrollTo({ left: 0, top: Math.min(y, Math.max(0, height - innerHeight)), behavior: "instant" });
      await nextPaint();
      await call({ type: "live.fullPageFrame", annotationId, y: scrollY });
      showFixed ??= hideFixed(hide);
      if (scrollY + innerHeight >= height || y + innerHeight >= height) break;
    }
    await call({ type: "live.fullPageEnd", annotationId });
    return null;
  } catch (e) {
    await call({ type: "live.fullPageCancel", annotationId }).catch(() => undefined);
    return `No full-page screenshot: ${messageOf(e)}`;
  } finally {
    showFixed?.();
    for (const el of hide) el.style.visibility = "";
    window.scrollTo({ ...start, behavior: "instant" });
  }
}
