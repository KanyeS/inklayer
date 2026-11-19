import type { Rect } from "@inklayer/overlay";
import { api, apiBytes } from "./api";
import { bytesToBase64 } from "./base64";

/**
 * Screenshots for comments, background side: taken when a comment is saved, cropped to the commented area and
 * uploaded; and fetched for the panel to show.
 */

const MAX_SCREENSHOT_WIDTH = 1600;
const MAX_SCREENSHOT_BYTES = 600 * 1024;
/** How long a finished upload's result is kept for the page to ask about. */
const KEEP_RESULT_MS = 60_000;

/** Screenshot uploads in progress or just finished, by comment. */
const uploads = new Map<string, Promise<void>>();

/** The part of the captured image (in its own pixels) that shows `area` (CSS pixels of a window `viewportWidth` wide). */
export function cropFor(
  imageSize: { width: number; height: number },
  area: Rect,
  viewportWidth: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const scale = imageSize.width / Math.max(1, viewportWidth); // the image's pixels per CSS pixel (pixel ratio and zoom)
  const sx = Math.round(area.x * scale);
  const sy = Math.round(area.y * scale);
  return {
    sx,
    sy,
    sw: Math.min(imageSize.width - sx, Math.round(area.width * scale)),
    sh: Math.min(imageSize.height - sy, Math.round(area.height * scale)),
  };
}

/** The image as WebP, or JPEG if that's smaller or WebP isn't available, at a quality that fits the size limit. */
async function compress(canvas: OffscreenCanvas): Promise<Blob> {
  let blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
  if (blob.type !== "image/webp" || blob.size > MAX_SCREENSHOT_BYTES) {
    blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  }
  if (blob.size > MAX_SCREENSHOT_BYTES) blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
  if (blob.size > MAX_SCREENSHOT_BYTES) throw new Error("the screenshot was too large to upload.");
  return blob;
}

/** Crops the captured window to the commented area, shrinks it if wide, and uploads it. */
async function uploadScreenshot(
  annotationId: string,
  dataUrl: string,
  area: Rect,
  viewportWidth: number,
): Promise<void> {
  const full = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const { sx, sy, sw, sh } = cropFor(full, area, viewportWidth);
  const shrink = Math.min(1, MAX_SCREENSHOT_WIDTH / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * shrink), Math.round(sh * shrink));
  canvas.getContext("2d")?.drawImage(full, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  full.close();

  const blob = await compress(canvas);
  const query = `width=${canvas.width}&height=${canvas.height}`;
  await api<null>(`/api/annotations/${encodeURIComponent(annotationId)}/screenshot?${query}`, {
    method: "PUT",
    headers: { "Content-Type": blob.type },
    body: blob,
  });
}

/** The message for a failed capture: browsers only allow screenshots with access to all sites (or just after a click). */
function captureError(error: unknown): unknown {
  if (!/all_urls|activeTab|permission/i.test(String(error))) return error;
  return new Error(
    'Inklayer isn\'t allowed to take screenshots yet. Click the Inklayer toolbar button, then "Allow screenshots".',
  );
}

/**
 * Takes the screenshot now, while the page shows the comment, then crops and uploads it in the background so the panel
 * can reappear at once. `uploadResult` reports how the upload went.
 */
export async function captureScreenshot(
  windowId: number,
  annotationId: string,
  area: Rect,
  viewportWidth: number,
): Promise<void> {
  let shot: string;
  try {
    shot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (error) {
    throw captureError(error);
  }
  const upload = uploadScreenshot(annotationId, shot, area, viewportWidth);
  uploads.set(annotationId, upload);
  void upload.catch(() => undefined).finally(() => setTimeout(() => uploads.delete(annotationId), KEEP_RESULT_MS));
}

/** Waits for a comment's screenshot upload; throws if it failed. */
export async function uploadResult(annotationId: string): Promise<void> {
  await uploads.get(annotationId);
}

/**
 * A comment's screenshot, as base64 for the page: the panel draws it on a canvas, which the page's content policy
 * can't block. Null if it has none.
 */
export async function screenshotForPage(annotationId: string): Promise<{ type: string; base64: string } | null> {
  const image = await apiBytes(`/api/annotations/${encodeURIComponent(annotationId)}/screenshot`);
  if (!image) return null;
  return { type: image.type, base64: bytesToBase64(new Uint8Array(image.bytes)) };
}
