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
  return target.height ? { width, height: Math.round(target.height + Math.max(0, now.outerHeight - now.innerHeight)) } : { width };
}
