import { putBytes } from "./api";

/**
 * Tab recordings, between the recording window (recorder.html) and the comment they go with. The window keeps the video
 * in IndexedDB, which the background can read too (messages can't carry large files); the background uploads it once
 * the comment is saved, then forgets it. Recordings not used within a day are dropped.
 */

const DB_NAME = "inklayer-recordings";
const STORE = "recordings";
const KEEP_MS = 24 * 60 * 60 * 1000;

/** The longest recording, in seconds. */
export const MAX_RECORDING_SECONDS = 60;

/** What the recording window tells the background when it's done, to pass on to the page. */
export interface RecordingDone {
  type: "recording.done";
  tabId: number;
  recordingId: string;
  seconds: number;
  size: number;
}

interface Stored {
  id: string;
  blob: Blob;
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

export async function saveRecording(id: string, blob: Blob): Promise<void> {
  await run("readwrite", (store) => store.put({ id, blob, at: Date.now() } satisfies Stored));
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
  await discardRecording(recordingId);
}

/** The best format this browser can record: WebM (VP9, then VP8), else MP4. Exported for tests. */
export function recordingType(supported: (type: string) => boolean): string | null {
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  return types.find(supported) ?? null;
}
