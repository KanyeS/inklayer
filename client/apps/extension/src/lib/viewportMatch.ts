/** Seeing a page at the size it was commented at: when the sizes differ enough to matter, and the window size that gives it. */

/** Whether the commenter's width is different enough from yours that the page may lay out differently. */
export function sizeDiffers(theirs: number, mine: number): boolean {
  return theirs > 0 && Math.abs(theirs - mine) > Math.max(40, mine * 0.05);
}

/**
 * The window size whose page area is <paramref name="target"/>: the target plus the browser's own frame (tabs, toolbars,
 * borders), which is what the window is bigger than the page by right now. Height is left alone when it isn't known.
 */
export function windowSizeFor(
  target: { width: number; height?: number | null },
  now: { innerWidth: number; innerHeight: number; outerWidth: number; outerHeight: number },
): { width: number; height?: number } {
  const width = Math.round(target.width + Math.max(0, now.outerWidth - now.innerWidth));
  return target.height
    ? { width, height: Math.round(target.height + Math.max(0, now.outerHeight - now.innerHeight)) }
    : { width };
}

export interface Size {
  width: number;
  height: number;
}

/** A window and the page inside it, measured at the same moment: window in screen units, page in CSS pixels. */
export interface WindowMeasure {
  window: Size;
  page: Size;
}

/** How close (CSS pixels) the page has to get to the target size to count as there. */
export const SIZE_TOLERANCE_PX = 2;

/** Whether the page is the target size, within a couple of pixels. Height is ignored when it isn't known. */
export function closeEnough(target: { width: number; height: number | null }, page: Size): boolean {
  const offW = target.width - page.width;
  const offH = target.height ? target.height - page.height : 0;
  return Math.abs(offW) <= SIZE_TOLERANCE_PX && Math.abs(offH) <= SIZE_TOLERANCE_PX;
}

/**
 * The next window size to try after a resize missed the target. Window sizes are in screen units and the page in CSS
 * pixels (page zoom and display scaling differ), so the ratio between them is learnt from how much the page changed
 * when the window did, and the remaining gap is scaled by it. A ratio of 1 is assumed when nothing changed.
 */
export function correctedWindowSize(
  target: { width: number; height: number | null },
  before: WindowMeasure,
  after: WindowMeasure,
): { width: number; height?: number } {
  const ratio = (screenDelta: number, cssDelta: number) =>
    cssDelta !== 0 && screenDelta !== 0 ? Math.abs(screenDelta / cssDelta) : 1;
  const perW = ratio(after.window.width - before.window.width, after.page.width - before.page.width);
  const perH = ratio(after.window.height - before.window.height, after.page.height - before.page.height);
  const width = Math.round(after.window.width + (target.width - after.page.width) * perW);
  if (!target.height) return { width };
  return { width, height: Math.round(after.window.height + (target.height - after.page.height) * perH) };
}
