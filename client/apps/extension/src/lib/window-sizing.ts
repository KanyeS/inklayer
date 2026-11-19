/**
 * "Match their size", background side: resizing the page's window and zooming its tab, and putting both back with
 * "Back to my size". How each window was before is kept in session storage, so it survives the page reloading.
 */

const SAVED_SIZES = "savedWindowSizes";
/** Some window managers (Linux especially) restore the old size just after leaving maximised: wait for that first. */
const UNMAXIMISE_SETTLE_MS = 400;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

type SavedSize = {
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  state?: `${chrome.windows.WindowState}`;
  /** The tab whose zoom was changed, and its zoom before. */
  zoomTabId?: number;
  zoom?: number;
};

/** Windows resized to a commenter's size, with how they were before. */
async function savedSizes(): Promise<Record<number, SavedSize>> {
  return ((await chrome.storage.session.get(SAVED_SIZES))[SAVED_SIZES] as Record<number, SavedSize> | undefined) ?? {};
}

/** Notes how a window (and the tab's zoom) was before the first change, for "Back to my size". */
async function rememberSize(windowId: number, tabId: number | undefined): Promise<void> {
  const saved = await savedSizes();
  if (saved[windowId]) return;
  const w = await chrome.windows.get(windowId);
  const zoom = tabId === undefined ? undefined : await chrome.tabs.getZoom(tabId).catch(() => undefined);
  saved[windowId] = {
    left: w.left,
    top: w.top,
    width: w.width,
    height: w.height,
    state: w.state,
    zoomTabId: tabId,
    zoom,
  };
  await chrome.storage.session.set({ [SAVED_SIZES]: saved });
}

/** Keeps a requested zoom within what browsers allow. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Resizes (and moves) the page's window, remembering how it was first. Maximised windows have to become normal to
 * resize. Returns the size the window actually got.
 */
export async function resizeWindow(
  windowId: number,
  tabId: number | undefined,
  size: { width: number; height?: number; left?: number; top?: number },
): Promise<{ width: number; height: number }> {
  await rememberSize(windowId, tabId);
  // Out of maximised first, and wait, so the size given next isn't undone.
  if ((await chrome.windows.get(windowId)).state !== "normal") {
    await chrome.windows.update(windowId, { state: "normal" });
    await new Promise((resolve) => setTimeout(resolve, UNMAXIMISE_SETTLE_MS));
  }
  const { width, height, left, top } = size;
  const updated = await chrome.windows.update(windowId, {
    width,
    ...(height ? { height } : {}),
    ...(left !== undefined ? { left } : {}),
    ...(top !== undefined ? { top } : {}),
  });
  return { width: updated.width ?? width, height: updated.height ?? height ?? 0 };
}

/** Zooms the page's tab (remembering the window and zoom first). Returns the zoom it got. */
export async function zoomTab(windowId: number, tabId: number, zoom: number): Promise<number> {
  await rememberSize(windowId, tabId);
  await chrome.tabs.setZoom(tabId, clampZoom(zoom));
  return chrome.tabs.getZoom(tabId);
}

/** Puts the window and zoom back as they were. Returns false if they hadn't been changed. */
export async function restoreWindow(windowId: number): Promise<boolean> {
  const saved = await savedSizes();
  const was = saved[windowId];
  if (!was) return false;
  delete saved[windowId];
  await chrome.storage.session.set({ [SAVED_SIZES]: saved });
  if (was.zoomTabId !== undefined && was.zoom)
    await chrome.tabs.setZoom(was.zoomTabId, was.zoom).catch(() => undefined);
  if (was.state === "maximized" || was.state === "fullscreen") {
    await chrome.windows.update(windowId, { state: was.state });
  } else {
    await chrome.windows.update(windowId, {
      state: "normal",
      left: was.left,
      top: was.top,
      width: was.width,
      height: was.height,
    });
  }
  return true;
}

/** Whether this window was resized to someone's size (and not put back yet). */
export async function windowResized(windowId: number): Promise<boolean> {
  return Boolean((await savedSizes())[windowId]);
}
