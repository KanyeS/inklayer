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
    ...(await pageLogs()),
  };
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
