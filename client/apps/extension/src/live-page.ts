import { commentToOpen } from "@inklayer/overlay";
import type { LiveInit } from "./lib/live";
import type { Response } from "./lib/messages";
import { call, messageOf } from "./live/call";
import type { View } from "./live/context";
import { RecordingEffects } from "./live/recording-effects";
import { LiveSession } from "./live/session";
import { PresenceClient } from "./presence-page";

/**
 * The live content script's entry point (built as live.js). It loads on every http(s) page but stays invisible unless
 * the site has comments (the background checks only the origin) or the user chooses "Comment on this page" in the
 * toolbar popup. The panel itself is LiveSession (live/session.ts); live cursors are PresenceClient.
 */

declare global {
  var __inklayerLive: boolean | undefined;
}

/** The hidden directive "Open on the page" adds to an address, naming the comment to open. */
const OPEN_DIRECTIVE = /:~:inklayer=comment:[^&#]*/;

let session: LiveSession | null = null;
let starting: Promise<void> | null = null;

/** Starts the session with comments already loaded, or opens it (on `view`) if it's running. */
function startSession(load: () => Promise<LiveInit | null>, open: boolean, view: View = "comments"): Promise<void> {
  if (session) {
    if (open) session.open(view);
    return Promise.resolve();
  }
  starting ??= (async () => {
    const init = await load();
    if (!init) return;
    session = new LiveSession(init);
    await session.start(open, view);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

/** Asks the background for this page's comments, as for "Comment on this page". */
function openPage(): Promise<LiveInit> {
  return call<LiveInit>({ type: "live.open", url: location.href });
}

/** Messages from our own extension only (the popup and background), never from pages. */
function fromUs(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id;
}

/** "Comment on this page" or "Activity log" from the toolbar popup. */
function listenForOpen(): void {
  chrome.runtime.onMessage.addListener((message: { type?: string; view?: View }, sender) => {
    if (!fromUs(sender) || message?.type !== "inklayer.live.open") return;
    const view: View = message.view === "activity" ? "activity" : "comments";
    startSession(openPage, true, view).catch((e: unknown) => window.alert(`Inklayer: ${messageOf(e)}`));
  });
}

/** "Open on the page" from the web viewer: the address carries a hidden directive naming the comment. */
function commentFromAddress(): string | null {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const wanted = commentToOpen(location.href, navigation?.name);
  if (wanted && location.href.includes(":~:inklayer=")) {
    // This browser left the directive in the address: take it out, so the site never sees it.
    history.replaceState(history.state, "", location.href.replace(OPEN_DIRECTIVE, "").replace(/#$/, ""));
  }
  return wanted;
}

/**
 * The recorder, recording this tab: clicks and drawing shown on the page while it records, and the recording, once
 * it's made, attached to the comment being written.
 */
function listenForRecordings(): void {
  const effects = new RecordingEffects();
  chrome.runtime.onMessage.addListener(
    (message: { type?: string; recordingId?: string; seconds?: number; recording?: boolean }, sender) => {
      if (!fromUs(sender)) return;
      if (message?.type === "inklayer.recordingState") {
        effects.setRecording(message.recording === true);
        session?.recordingTab(message.recording === true);
      } else if (message?.type === "inklayer.recordingDraw") effects.toggleDrawing();
      else if (message?.type === "inklayer.recording" && message.recordingId)
        session?.recordingReady(message.recordingId, message.seconds ?? 0);
    },
  );
}

/** Live cursors: only in tabs where the user turned them on in the toolbar popup. The flag lasts until the tab closes. */
function startPresence(): void {
  const presence = new PresenceClient(() => Array.from(document.querySelectorAll("inklayer-live, inklayer-bubbles")));
  chrome.runtime.onMessage.addListener((message: { type?: string; on?: boolean }, sender) => {
    if (!fromUs(sender) || message?.type !== "inklayer.presence") return;
    if (message.on) presence.start();
    else presence.stop();
  });
  void chrome.runtime
    .sendMessage({ type: "presence.status" })
    .then((response: Response<boolean> | undefined) => {
      if (response?.ok && response.value) presence.start();
    })
    .catch(() => undefined);
}

if (!globalThis.__inklayerLive && window.top === window) {
  globalThis.__inklayerLive = true;
  listenForOpen();
  listenForRecordings();

  const wanted = commentFromAddress();
  if (wanted) {
    void startSession(openPage, true)
      .then(() => session?.focusComment(wanted))
      .catch(() => undefined);
  } else {
    // Automatically, only if this site has comments, or this page is a pull request with comments linked to it (the
    // background checks both locally before asking about this page).
    const check = () =>
      startSession(() => call<LiveInit | null>({ type: "live.check", url: location.href }), false).catch(
        () => undefined,
      );
    void check();
    // Sites like GitHub change pages without reloading: check again when the address changes, until a session starts.
    let checked = location.href;
    const watch = window.setInterval(() => {
      if (session) {
        window.clearInterval(watch);
        return;
      }
      if (location.href === checked || starting) return;
      checked = location.href;
      void check();
    }, 1500);
  }

  startPresence();
}
