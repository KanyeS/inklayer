import { putBytes } from "./api";

/**
 * Tab recordings, between the recorder (see recorder-session.ts) and the comment they go with. The recorder keeps the video
 * in IndexedDB, which the background can read too (messages can't carry large files); the background uploads it once
 * the comment is saved, then forgets it. Recordings not used within a day are dropped.
 */

const DB_NAME = "inklayer-recordings";
const STORE = "recordings";
const KEEP_MS = 24 * 60 * 60 * 1000;

/** The longest recording, in seconds. */
export const MAX_RECORDING_SECONDS = 60;

/** The bar on the page asks the background to switch drawing on or off on the page. */
export interface RecordingSignal {
  type: "recording.draw";
  /** As in RecordingDone. */
  tabId: number | null;
}

/** What the recorder tells the background when the video is kept, to pass on to the tab's page. */
export interface RecordingDone {
  type: "recording.done";
  /** The tab it's for; null from the bar, which is in the tab's own page. */
  tabId: number | null;
  recordingId: string;
  seconds: number;
  size: number;
}

interface Stored {
  id: string;
  blob: Blob;
  /** A still from early in the recording, with a play symbol: shown in issues where the video can't play. */
  poster?: Blob;
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRecording(id: string, blob: Blob, poster: Blob | null): Promise<void> {
  await run("readwrite", (store) =>
    store.put({ id, blob, poster: poster ?? undefined, at: Date.now() } satisfies Stored),
  );
  void pruneRecordings();
}

export async function discardRecording(id: string): Promise<void> {
  await run("readwrite", (store) => store.delete(id));
}

/** Drops recordings older than a day: ones whose comment was never saved. */
export async function pruneRecordings(): Promise<void> {
  const all = await run<Stored[]>("readonly", (store) => store.getAll() as IDBRequest<Stored[]>);
  for (const old of all.filter((r) => Date.now() - r.at > KEEP_MS)) await discardRecording(old.id);
}

/** Uploads a recording to its comment, then forgets it. */
export async function uploadRecording(annotationId: string, recordingId: string): Promise<void> {
  const stored = await run<Stored | undefined>(
    "readonly",
    (store) => store.get(recordingId) as IDBRequest<Stored | undefined>,
  );
  if (!stored) throw new Error("the recording is gone (recordings are kept for a day).");
  const type = stored.blob.type.split(";")[0] || "video/webm";
  await putBytes(`/api/annotations/${encodeURIComponent(annotationId)}/media/video`, new Blob([stored.blob], { type }));
  if (stored.poster) {
    await putBytes(`/api/annotations/${encodeURIComponent(annotationId)}/media/thumbnail`, stored.poster).catch(
      () => undefined,
    );
  }
  await discardRecording(recordingId);
}

/** The still's size, and how far into the recording it's taken. */
const POSTER_WIDTH = 640;
export const POSTER_AT_MS = 800;

/** Draws a still from `video` with a play symbol over it, as a JPEG; null if there's no picture yet. */
export async function posterFrom(video: HTMLVideoElement): Promise<Blob | null> {
  if (!video.videoWidth || !video.videoHeight) return null;
  const width = Math.min(POSTER_WIDTH, video.videoWidth);
  const height = Math.round(video.videoHeight * (width / video.videoWidth));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, width, height);
  const r = Math.round(Math.min(width, height) * 0.12);
  const [x, y] = [width / 2, height / 2];
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(x - r * 0.35, y - r * 0.5);
  ctx.lineTo(x + r * 0.55, y);
  ctx.lineTo(x - r * 0.35, y + r * 0.5);
  ctx.closePath();
  ctx.fill();
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
}

/** The best format this browser can record: WebM (VP9, then VP8), else MP4. Exported for tests. */
export function recordingType(supported: (type: string) => boolean): string | null {
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return types.find(supported) ?? null;
}
