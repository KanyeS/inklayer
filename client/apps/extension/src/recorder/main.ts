import { MAX_RECORDING_SECONDS, type RecordingDone, recordingType, saveRecording } from "../lib/recordings";

/**
 * The recording window: opened from a new comment, it records a tab (the person picks it in the browser's share prompt)
 * for up to a minute, keeps the video for the background to upload with the comment, and tells the page it's there.
 * Recording starts from here, an extension page, so the recorded site's own policies can't block it.
 */

const tabId = Number(new URLSearchParams(location.search).get("tab"));
const action = document.getElementById("action") as HTMLButtonElement;
const time = document.getElementById("time") as HTMLSpanElement;
const status = document.getElementById("status") as HTMLParagraphElement;

let recorder: MediaRecorder | null = null;

function say(text: string, error = false): void {
  status.textContent = text;
  status.className = error ? "error" : "";
}

async function start(): Promise<void> {
  const type = recordingType((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return say("This browser can't record video.", true);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
  } catch {
    return say("Nothing was shared. Start again when you're ready.");
  }

  const chunks: Blob[] = [];
  recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 2_500_000 });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const began = Date.now();
  const tick = setInterval(() => {
    const seconds = Math.floor((Date.now() - began) / 1000);
    time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} / 1:00`;
    if (seconds >= MAX_RECORDING_SECONDS) recorder?.stop();
  }, 250);
  recorder.onstop = () => {
    clearInterval(tick);
    for (const track of stream.getTracks()) track.stop();
    void finish(new Blob(chunks, { type: type.split(";")[0] }), Math.round((Date.now() - began) / 1000));
  };
  // The browser's own "Stop sharing" ends it too.
  for (const track of stream.getVideoTracks())
    track.addEventListener("ended", () => recorder?.state === "recording" && recorder.stop());
  recorder.start(1000);
  action.textContent = "Stop";
  action.className = "stop";
  say("Recording. Switch to the tab and show what's wrong.");
}

async function finish(blob: Blob, seconds: number): Promise<void> {
  action.disabled = true;
  if (blob.size === 0) return say("The recording was empty.", true);
  const recordingId = crypto.randomUUID();
  try {
    await saveRecording(recordingId, blob);
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
  say("Attached to your comment. Save the comment to send it.");
  setTimeout(() => window.close(), 1200);
}

action.addEventListener("click", () => {
  if (recorder?.state === "recording") recorder.stop();
  else void start();
});
