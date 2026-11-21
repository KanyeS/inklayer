import { MAX_RECORDING_SECONDS } from "../lib/recordings";
import { listenForStop, type Recording, record } from "./engine";
import { clock, say, ui } from "./ui";

/**
 * The small recorder window, for browsers that can't record from a hidden page (Firefox): the person clicks Start and
 * picks what to share (the browser only allows that from a click), then it minimises and records while they change
 * pages. It closes itself once the recording is kept: only after the share has ended (closing a page that's sharing
 * crashes the Firefox snap).
 */
export function startWindow(tabId: number): void {
  let recording: Recording | null = null;
  let finished = false;
  listenForStop(() => (recording ? [recording] : []));

  ui.action.addEventListener("click", () => {
    if (finished) window.close();
    else if (recording) recording.stop();
    else void start();
  });

  async function start(): Promise<void> {
    let stream: MediaStream;
    try {
      // Plain video, as asked for: constraints can make Firefox renegotiate the share, which fails in the Firefox snap.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch {
      return say("Nothing was shared. Start again when you're ready.");
    }
    const began = Date.now();
    const tick = setInterval(() => {
      ui.time.textContent = clock(Math.floor((Date.now() - began) / 1000), MAX_RECORDING_SECONDS);
    }, 250);
    recording = record(stream, tabId, (error) => {
      clearInterval(tick);
      recording = null;
      finished = true;
      ui.action.textContent = "Close";
      ui.action.className = "";
      if (error) return say(error, true);
      say("Attached to your comment.");
      setTimeout(() => window.close(), 1500);
    });
    ui.action.textContent = "Stop";
    ui.action.className = "stop";
    say("Recording. Go back to the tab: it keeps recording when you change pages.");
  }
}
