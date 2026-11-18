import { resolveCapture, sha256Hex, type CapturedAsset, type FetchedResource, type SerializedPage } from "@inklayer/capture";
import { api, postJson, type Snapshot } from "./api";

export type CaptureStatus =
  | { state: "idle" }
  | { state: "working"; step: string; progress?: number }
  | { state: "done"; snapshot: Snapshot; failedResources: number }
  | { state: "error"; message: string };

const MAX_RESOURCE_BYTES = 25 * 1024 * 1024;
const UPLOAD_CONCURRENCY = 4;

/**
 * Captures a tab into a project, in this order:
 * <ol>
 * <li>Screenshot of the visible area.</li>
 * <li>Serialize the DOM in the page.</li>
 * <li>Fetch and hash every resource (using the extension's host permissions, with the user's cookies).</li>
 * <li>Upload only the blobs the server doesn't have.</li>
 * <li>Create the snapshot.</li>
 * </ol>
 * Progress is written to chrome.storage.session, so it survives the popup closing.
 */
export async function captureTab(tab: chrome.tabs.Tab, projectId: string, maskSelector: string | null): Promise<Snapshot> {
  if (tab.id === undefined || tab.windowId === undefined) throw new Error("No tab to capture.");
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000); // keep the service worker awake
  try {
    await setStatus({ state: "working", step: "Taking screenshot…" });
    const screenshot = await takeScreenshot(tab.windowId);

    await setStatus({ state: "working", step: "Reading the page…" });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (mask: string | null) => globalThis.__inklayerCapture!(mask),
      args: [maskSelector],
    });
    const page = injection?.result as SerializedPage | undefined;
    if (!page) throw new Error("This page can't be captured (browser pages and extension stores are off limits).");

    await setStatus({ state: "working", step: "Collecting images, fonts and styles…", progress: 0 });
    const resolved = await resolveCapture(page, fetchResource, {
      onProgress: (done, total) => void setStatus({ state: "working", step: `Collecting images, fonts and styles (${done}/${total})…`, progress: done / total }),
    });

    const blobs = new Map<string, CapturedAsset>();
    for (const asset of [resolved.document, ...resolved.assets]) blobs.set(asset.hash, asset);
    if (screenshot) blobs.set(screenshot.hash, screenshot);

    await uploadMissing(projectId, blobs);

    await setStatus({ state: "working", step: "Saving snapshot…" });
    const snapshot = await postJson<Snapshot>(`/api/projects/${projectId}/snapshots`, {
      url: page.meta.url,
      title: page.meta.title,
      viewportWidth: page.meta.viewportWidth,
      viewportHeight: page.meta.viewportHeight,
      devicePixelRatio: page.meta.devicePixelRatio,
      scrollX: page.meta.scrollX,
      scrollY: page.meta.scrollY,
      userAgent: page.meta.userAgent,
      documentHash: resolved.document.hash,
      screenshotHash: screenshot?.hash ?? null,
      assets: resolved.assets.map((a) => ({ hash: a.hash, contentType: a.contentType })),
    });

    await setStatus({ state: "done", snapshot, failedResources: resolved.failed.length });
    return snapshot;
  } catch (error) {
    await setStatus({ state: "error", message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    clearInterval(keepAlive);
  }
}

async function takeScreenshot(windowId: number): Promise<CapturedAsset | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    const bytes = Uint8Array.from(atob(dataUrl.split(",", 2)[1] ?? ""), (c) => c.charCodeAt(0));
    return { hash: await sha256Hex(bytes), contentType: "image/png", bytes };
  } catch {
    return null; // a screenshot is a bonus; the snapshot is still useful without it
  }
}

async function fetchResource(url: string): Promise<FetchedResource | null> {
  try {
    const response = await fetch(url, { credentials: "include", cache: "force-cache", redirect: "follow" });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_RESOURCE_BYTES) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESOURCE_BYTES) return null;
    return { bytes, contentType: response.headers.get("content-type") };
  } catch {
    return null;
  }
}

async function uploadMissing(projectId: string, blobs: Map<string, CapturedAsset>): Promise<void> {
  const { missing } = await postJson<{ missing: string[] }>(`/api/projects/${projectId}/blobs/missing`, { hashes: [...blobs.keys()] });
  let uploaded = 0;
  const queue = [...missing];
  const worker = async () => {
    for (let hash = queue.shift(); hash; hash = queue.shift()) {
      const blob = blobs.get(hash)!;
      await api(`/api/projects/${projectId}/blobs/${hash}`, {
        method: "PUT",
        headers: { "Content-Type": blob.contentType },
        body: blob.bytes as Uint8Array<ArrayBuffer>,
      });
      uploaded++;
      await setStatus({ state: "working", step: `Uploading (${uploaded}/${missing.length})…`, progress: uploaded / Math.max(1, missing.length) });
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
}

export async function setStatus(status: CaptureStatus): Promise<void> {
  await chrome.storage.session.set({ captureStatus: status });
}

export async function getStatus(): Promise<CaptureStatus> {
  const { captureStatus } = await chrome.storage.session.get("captureStatus");
  return (captureStatus as CaptureStatus | undefined) ?? { state: "idle" };
}
