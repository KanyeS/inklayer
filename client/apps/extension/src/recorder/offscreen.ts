import { listenForStop, type Recording, record } from "./engine";

/**
 * The hidden recorder (Chrome's offscreen document): records what the person chose to share in the bar on the page, so
 * the recording carries on while they change pages. The background makes this page when it's needed and closes it once
 * nothing is recorded here.
 */

const recordings = new Map<number, Recording>();

chrome.runtime.onMessage.addListener(
  (message: { type?: string; tabId?: number; streamId?: string }, sender, reply: (r: unknown) => void) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "offscreen.record") return;
    const { tabId, streamId } = message;
    if (tabId === undefined || !streamId) return;
    void start(tabId, streamId).then(
      () => reply({ ok: true }),
      (e: unknown) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return true; // replies once the share is open
  },
);

async function start(tabId: number, streamId: string): Promise<void> {
  recordings.get(tabId)?.stop();
  // The share chosen with desktopCapture in the bar: only this extension's pages can open it.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } },
  } as unknown as MediaStreamConstraints);
  // Not const: `record` can end at once (a browser that can't record), before it returns.
  let recording: Recording | null = null;
  recording = record(stream, tabId, () => {
    if (recordings.get(tabId) === recording) recordings.delete(tabId);
  });
  recordings.set(tabId, recording);
}

listenForStop(() => recordings.values());
