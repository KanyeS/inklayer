import { MAX_RECORDING_SECONDS } from "../lib/recordings";
import { listenForStop, type Recording, record } from "./engine";
import { clock, say, ui } from "./ui";

/**
 * Inklayer's sidebar in Firefox, where a tab's recording is made: it stays open while the page changes, so the
 * recording carries on. Firefox only shares from a click in the page that records, so the person clicks Start here
 * once; after that the bar on each page has Stop and Draw. Closing the sidebar while recording ends the recording.
 */

let recording: Recording | null = null;
/** The tab waiting to be recorded, in this sidebar's browser window. */
let waiting: number | null = null;
let windowId: number | null = null;
listenForStop(() => (recording ? [recording] : []));

async function refresh(): Promise<void> {
  if (recording || windowId === null) return;
  const reply = (await chrome.runtime.sendMessage({ type: "recorder.waiting", windowId })) as
    | { ok: boolean; value?: number | null }
    | undefined;
  const next = reply?.ok ? (reply.value ?? null) : null;
  if (next === waiting && !ui.action.hidden === (waiting !== null)) return; // unchanged: keep what's said
  waiting = next;
  ui.action.hidden = waiting === null;
  ui.action.textContent = "Start recording";
  ui.action.className = "";
  if (waiting !== null) say("Click Start recording, then pick what to share.");
}

ui.action.addEventListener("click", () => {
  if (recording) recording.stop();
  else if (waiting !== null) void start(waiting);
});

async function start(tabId: number): Promise<void> {
  let stream: MediaStream;
  try {
    // Plain video, as asked for: constraints can make Firefox renegotiate the share, which fails in the Firefox snap.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    return say(`Nothing was shared (${e instanceof Error ? e.message : String(e)}). Start again when you're ready.`);
  }
  const began = Date.now();
  const tick = setInterval(() => {
    ui.time.textContent = clock(Math.floor((Date.now() - began) / 1000), MAX_RECORDING_SECONDS);
  }, 250);
  recording = record(stream, tabId, (error) => {
    clearInterval(tick);
    recording = null;
    ui.time.textContent = "";
    if (error) say(error, true);
    else say("Attached to your comment. You can close the sidebar.");
    void refresh();
  });
  ui.action.textContent = "Stop";
  ui.action.className = "stop";
  say("Recording. Stop and Draw are at the bottom of the page.");
}

// A bar asked for a recording (or gave up): show Start for it.
chrome.runtime.onMessage.addListener((message: { type?: string }, sender) => {
  if (sender.id === chrome.runtime.id && message?.type === "recorder.changed") void refresh();
});
void chrome.windows.getCurrent().then((w) => {
  windowId = w.id ?? null;
  void refresh();
});
// Also asked every second, in case the background's messages don't arrive.
setInterval(() => void refresh().catch(() => undefined), 1000);
