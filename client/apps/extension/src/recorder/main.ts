import {
  MAX_RECORDING_SECONDS,
  POSTER_AT_MS,
  posterFrom,
  type RecordingDone,
  type RecordingSignal,
  recordingType,
  saveRecording,
} from "../lib/recordings";

/**
 * The recorder: shown in a new comment's box on the page (embedded), or in its own window. It records a tab (the person
 * picks it in the browser's share prompt) for up to a minute, keeps the video for the background to upload with the
 * comment, and tells the page it's there. Recording starts from here, an extension page, so the browser's prompt names
 * Inklayer rather than the site.
 */

const params = new URLSearchParams(location.search);
/** In its own window, the tab it's for; embedded, the background knows the tab it's in. */
const tabId = Number(params.get("tab")) || null;
const embedded = params.has("embedded");
if (embedded) document.body.classList.add("embedded");
const action = document.getElementById("action") as HTMLButtonElement;
const draw = document.getElementById("draw") as HTMLButtonElement;
const time = document.getElementById("time") as HTMLSpanElement;
const status = document.getElementById("status") as HTMLParagraphElement;

let recorder: MediaRecorder | null = null;

/** Tells the page it's being recorded (it shows clicks then), or to switch drawing on or off. */
function signal(type: RecordingSignal["type"], recording?: boolean): void {
  void chrome.runtime.sendMessage({ type, tabId, recording } satisfies RecordingSignal).catch(() => undefined);
}
let stopSharing: () => void = () => undefined;

function say(text: string, error = false): void {
  status.textContent = text;
  status.className = error ? "error" : "";
}

async function start(): Promise<void> {
  const type = recordingType((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return say("This browser can't record video.", true);
  let stream: MediaStream;
  try {
    // Plain video, as asked for: constraints can make Firefox renegotiate the share, which fails in the Firefox snap.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch {
    return say("Nothing was shared. Start again when you're ready.");
  }

  // A still for issues, taken from the shared picture a moment in (before anything can end it).
  let poster: Promise<Blob | null> = Promise.resolve(null);
  const preview = document.createElement("video");
  preview.muted = true;
  preview.srcObject = stream;
  void preview.play().catch(() => undefined);
  // The preview stays attached until the share ends: detaching from a live share crashes the Firefox snap (see stopSharing).
  setTimeout(() => {
    poster = posterFrom(preview).catch(() => null);
  }, POSTER_AT_MS);

  const chunks: Blob[] = [];
  recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const began = Date.now();
  const tick = setInterval(() => {
    const seconds = Math.floor((Date.now() - began) / 1000);
    time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} / 1:00`;
    if (seconds >= MAX_RECORDING_SECONDS) stopSharing();
  }, 250);
  recorder.onstop = () => {
    clearInterval(tick);
    signal("recording.state", false);
    draw.hidden = true;
    for (const track of stream.getTracks()) track.stop();
    void poster.then((still) =>
      finish(new Blob(chunks, { type: type.split(";")[0] }), still, Math.round((Date.now() - began) / 1000)),
    );
  };
  // Stopping ends the share, and the recorder finishes when its video does. Stopping the recorder while the share is live
  // crashes Firefox on Linux (the snap, in its PipeWire screen capture); this window is left open for the same reason.
  stopSharing = () => {
    for (const track of stream.getTracks()) track.stop();
    // Browsers that don't end the recorder with its tracks.
    setTimeout(() => recorder?.state === "recording" && recorder.stop(), 1000);
  };
  // The browser's own "Stop sharing" ends it too.
  for (const track of stream.getVideoTracks())
    track.addEventListener("ended", () => recorder?.state === "recording" && recorder.stop());
  recorder.start(1000);
  signal("recording.state", true);
  draw.hidden = false;
  action.textContent = "Stop";
  action.className = "stop";
  say(embedded ? "" : "Recording. Switch to the tab and show what's wrong.");
}

let done = false;

async function finish(blob: Blob, poster: Blob | null, seconds: number): Promise<void> {
  done = true;
  action.textContent = "Close";
  action.className = "";
  if (blob.size === 0) return say("The recording was empty.", true);
  const recordingId = crypto.randomUUID();
  try {
    await saveRecording(recordingId, blob, poster);
    await chrome.runtime.sendMessage({
      type: "recording.done",
      tabId,
      recordingId,
      seconds,
      size: blob.size,
    } satisfies RecordingDone);
  } catch (e) {
    return say(`The recording couldn't be kept: ${e instanceof Error ? e.message : String(e)}`, true);
  }
  say(
    embedded
      ? "Attached to your comment."
      : "Attached to your comment. Save the comment to send it. You can close this window.",
  );
}

// The comment box asks it to stop when the comment is cancelled, so the share ends before the recorder is removed.
window.addEventListener("message", (e) => {
  if (e.source === window.parent && (e.data as { type?: string } | null)?.type === "inklayer.recorder.stop")
    stopSharing();
});

draw.addEventListener("click", () => signal("recording.draw"));

action.addEventListener("click", () => {
  if (done) window.close();
  else if (recorder?.state === "recording") stopSharing();
  else void start();
});
