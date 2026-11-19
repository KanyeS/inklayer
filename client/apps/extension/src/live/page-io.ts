import type { PageContext } from "../lib/live";
import { call } from "./call";

/** Data the live panel fetches from the background or the page itself: screenshots, page logs and the panel font. */

/** The font the panel asks for, registered on the page under a name of its own so it never clashes with the site's. */
export const PANEL_FONT = "Inklayer Outfit";

/** Decodes base64 (as the background sends binary data) into bytes. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

let panelFontRequested = false;

/** Adds the theme's font to the page, once, when the panel first shows. Without it the panel uses the system font. */
export async function loadPanelFont(): Promise<void> {
  if (panelFontRequested) return;
  panelFontRequested = true;
  try {
    const bytes = base64ToBytes(await call<string>({ type: "live.font" }));
    const face = new FontFace(PANEL_FONT, bytes.buffer, { weight: "100 900", display: "swap" });
    document.fonts.add(await face.load());
  } catch {
    // The system font is fine.
  }
}

/** Screenshots fetched through the background, decoded once per page. */
const screenshots = new Map<string, Promise<ImageBitmap | null>>();

/** A comment's screenshot, or null if it has none or it couldn't be loaded. */
export function loadScreenshot(annotationId: string): Promise<ImageBitmap | null> {
  let entry = screenshots.get(annotationId);
  if (!entry) {
    entry = call<{ type: string; base64: string } | null>({ type: "live.screenshot", annotationId })
      .then((image) =>
        image ? createImageBitmap(new Blob([base64ToBytes(image.base64)], { type: image.type })) : null,
      )
      .catch(() => null);
    screenshots.set(annotationId, entry);
  }
  return entry;
}

/** Draws a bitmap onto a canvas at its full size. */
export function paint(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
}

type PageLogs = Pick<PageContext, "console" | "network">;

/** How long to wait for capture.js to answer before going without logs. */
const PAGE_LOGS_TIMEOUT_MS = 300;

/**
 * The page's recent console errors and failed requests, kept by capture.js in the page's own world. Empty if that
 * script isn't there (e.g. the page loaded before the extension was set up).
 */
export function pageLogs(): Promise<PageLogs> {
  return new Promise((resolve) => {
    const nonce = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; // randomUUID needs https
    const done = (value: PageLogs) => {
      document.removeEventListener("inklayer:context-response", onResponse);
      clearTimeout(timer);
      resolve(value);
    };
    const onResponse = (e: Event) => {
      try {
        const data = JSON.parse(String((e as CustomEvent<unknown>).detail)) as { nonce: string } & PageLogs;
        if (data.nonce === nonce) done({ console: data.console ?? [], network: data.network ?? [] });
      } catch {
        // Not ours.
      }
    };
    const timer = window.setTimeout(() => done({ console: [], network: [] }), PAGE_LOGS_TIMEOUT_MS);
    document.addEventListener("inklayer:context-response", onResponse);
    document.dispatchEvent(new CustomEvent("inklayer:context-request", { detail: nonce }));
  });
}

/** Waits two frames, so a style change (e.g. hiding the panel before a screenshot) has been painted. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
