import type { RecorderMessage } from "../lib/recorder-protocol";
import {
  MAX_RECORDING_SECONDS,
  POSTER_AT_MS,
  posterFrom,
  type RecordingDone,
  recordingType,
  saveRecording,
} from "../lib/recordings";

/**
 * Records a shared screen, window or tab for a tab's comment, up to a minute, wherever the recording is made (the
 * hidden page, or the small window). It tells the background when it starts and when the video is kept; the background
 * tells the tab's pages. It stops when asked, when the minute is up, or when the browser's own "Stop sharing" is used.
 */
export interface Recording {
  readonly tabId: number;
  stop(): void;
}

function send(message: RecorderMessage | RecordingDone): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Records `stream` for `tabId`. `ended` is called once it's over (kept or not), with the problem if there was one. */
export function record(stream: MediaStream, tabId: number, ended: (error: string | null) => void): Recording {
  const type = recordingType((t) => MediaRecorder.isTypeSupported(t));
  if (!type) {
    for (const track of stream.getTracks()) track.stop();
    void send({ type: "recorder.failed", tabId, error: "This browser can't record video." });
    ended("This browser can't record video.");
    return { tabId, stop: () => undefined };
  }

  // A still for issues, taken from the shared picture a moment in (before anything can end it).
  let poster: Promise<Blob | null> = Promise.resolve(null);
  const preview = document.createElement("video");
  preview.muted = true;
  preview.srcObject = stream;
  void preview.play().catch(() => undefined);
  // The preview stays attached until the share ends: detaching from a live share crashes the Firefox snap (see stop).
  setTimeout(() => {
    poster = posterFrom(preview).catch(() => null);
  }, POSTER_AT_MS);

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const began = Date.now();
  const tick = setInterval(() => {
    if (Date.now() - began >= MAX_RECORDING_SECONDS * 1000) stop();
  }, 250);

  recorder.onstop = () => {
    clearInterval(tick);
    for (const track of stream.getTracks()) track.stop();
    const seconds = Math.round((Date.now() - began) / 1000);
    void poster.then((still) => finish(new Blob(chunks, { type: type.split(";")[0] }), still, seconds));
  };

  async function finish(blob: Blob, still: Blob | null, seconds: number): Promise<void> {
    if (blob.size === 0) {
      await send({ type: "recorder.failed", tabId, error: "The recording was empty." });
      return ended("The recording was empty.");
    }
    const recordingId = crypto.randomUUID();
    try {
      await saveRecording(recordingId, blob, still);
    } catch (e) {
      const error = `The recording couldn't be kept: ${e instanceof Error ? e.message : String(e)}`;
      await send({ type: "recorder.failed", tabId, error });
      return ended(error);
    }
    await send({ type: "recording.done", tabId, recordingId, seconds, size: blob.size });
    ended(null);
  }

  // Stopping ends the share, and the recorder finishes when its video does. Stopping the recorder while the share is live
  // crashes Firefox on Linux (the snap, in its PipeWire screen capture).
  function stop(): void {
    for (const track of stream.getTracks()) track.stop();
    // Browsers that don't end the recorder with its tracks.
    setTimeout(() => recorder.state === "recording" && recorder.stop(), 1000);
  }

  // The browser's own "Stop sharing" ends it too.
  for (const track of stream.getVideoTracks())
    track.addEventListener("ended", () => recorder.state === "recording" && recorder.stop());
  recorder.start(1000);
  void send({ type: "recorder.started", tabId, startedAt: began });
  return { tabId, stop };
}

/** Listens for the background asking to stop a tab's recording made here. */
export function listenForStop(recordings: () => Iterable<Recording>): void {
  chrome.runtime.onMessage.addListener((message: { type?: string; tabId?: number }, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "recorder.stop") return;
    for (const recording of recordings()) if (recording.tabId === message.tabId) recording.stop();
  });
}
