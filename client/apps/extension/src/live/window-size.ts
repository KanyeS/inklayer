import {
  closeEnough,
  correctedWindowSize,
  SIZE_TOLERANCE_PX,
  type Size,
  type WindowMeasure,
  windowSizeFor,
} from "../lib/viewportMatch";
import { call } from "./call";
import { percent } from "./format";

/**
 * "Match their size": resizes this browser window so the page is laid out at the size a comment was made at.
 * Window sizes are in screen units and the page in CSS pixels (page zoom, display scaling), so it measures the result
 * and corrects, a few times at most. When the window can't get there, it zooms the page instead.
 */

const MAX_PASSES = 3;
/** After the window reports a resize, give the page this long to lay out again. */
const LAYOUT_SETTLE_MS = 150;
/** Give up waiting for a resize event after this long (the size may not have changed at all). */
const RESIZE_TIMEOUT_MS = 900;
const ZOOM_TIMEOUT_MS = 700;

export interface TargetSize {
  width: number;
  height: number | null;
}

/** Resolves once the window has been resized and laid out, or after `timeoutMs` if it never is. */
function afterResize(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("resize", () => window.setTimeout(resolve, LAYOUT_SETTLE_MS), { once: true });
    window.setTimeout(resolve, timeoutMs);
  });
}

/** Where a window of this size sits centred on the screen. */
function centredOnScreen(width: number, height: number): { left: number; top: number } {
  const area = screen as Screen & { availLeft?: number; availTop?: number };
  return {
    left: Math.round((area.availLeft ?? 0) + Math.max(0, (screen.availWidth - width) / 2)),
    top: Math.round((area.availTop ?? 0) + Math.max(0, (screen.availHeight - height) / 2)),
  };
}

async function resizeWindow(size: { width: number; height?: number }): Promise<Size> {
  const resized = afterResize(RESIZE_TIMEOUT_MS);
  const result = await call<Size>({
    type: "live.matchSize",
    ...size,
    ...centredOnScreen(size.width, size.height ?? outerHeight),
  });
  await resized;
  return result;
}

async function setZoom(zoom: number): Promise<number> {
  const done = afterResize(ZOOM_TIMEOUT_MS);
  const set = await call<number>({ type: "live.setZoom", zoom });
  await done;
  return set;
}

function pageSize(): Size {
  return { width: innerWidth, height: innerHeight };
}

/**
 * Resizes the window (and if need be zooms the page) so the page is `target` CSS pixels, centred on the screen.
 * Returns a note to show when the result isn't exactly what was asked for, or "" when it is. Throws if the browser
 * refuses.
 */
export async function matchWindowSize(target: TargetSize, theirZoom: number | null): Promise<string> {
  // Their zoom first (zoom changes the page's width in CSS pixels), then the window.
  if (theirZoom) await setZoom(theirZoom);

  // First guess: the target plus the browser's frame.
  let guess = windowSizeFor(target, { innerWidth, innerHeight, outerWidth, outerHeight });
  let before: WindowMeasure = { window: { width: outerWidth, height: outerHeight }, page: pageSize() };
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const after: WindowMeasure = { window: await resizeWindow(guess), page: pageSize() };
    if (closeEnough(target, after.page)) break;
    const pageUnchanged = after.page.width === before.page.width && after.page.height === before.page.height;
    if (pageUnchanged && pass > 0) break; // the browser won't go further
    guess = correctedWindowSize(target, before, after);
    before = after;
  }

  if (Math.abs(innerWidth - target.width) <= SIZE_TOLERANCE_PX) return "";
  return zoomToWidth(target.width, theirZoom);
}

/**
 * The window can't get there (minimum width, or the screen isn't wide enough): zoom so the page lays out at their
 * width anyway. Text looks bigger or smaller than they saw it, but the layout is theirs.
 */
async function zoomToWidth(width: number, theirZoom: number | null): Promise<string> {
  const current = await call<number>({ type: "live.getZoom" });
  const set = await setZoom((current * innerWidth) / width);
  if (Math.abs(innerWidth - width) <= SIZE_TOLERANCE_PX) {
    const theirs = theirZoom ? ` (they were at ${percent(theirZoom)})` : "";
    return `Your window can't be ${width}px wide, so the page is zoomed to ${percent(set)} to lay out at their width${theirs}.`;
  }
  return `This is as close as your browser gets: ${innerWidth}px wide at ${percent(set)} zoom. For phone sizes, DevTools' device mode (Ctrl+Shift+M) goes further.`;
}
