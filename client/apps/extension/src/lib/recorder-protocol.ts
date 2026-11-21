import type { Draft } from "@inklayer/overlay";

/**
 * A tab's recording, kept by the background while the person moves between pages. The recording itself is made
 * outside the page (in a hidden extension page in Chrome, or a small window), so page changes don't end it; the bar
 * at the bottom of each page is only a remote control for it.
 */
export interface RecorderState {
  tabId: number;
  /** Choosing what to share (the browser's prompt is up), recording, or finished with the recording kept. */
  phase: "choosing" | "recording" | "done";
  /**
   * Where it's recorded: a hidden extension page (Chrome), Inklayer's sidebar (Firefox), or a small window. The sidebar
   * and the window need a click to start (Firefox only shares from a click in the page that records).
   */
  mode: "hidden" | "sidebar" | "window";
  /** The small window, or the browser window whose sidebar records. */
  windowId?: number;
  /** When recording started (ms since the epoch), for the timer on each page. */
  startedAt?: number;
  /** The finished recording, until the comment it's for is saved or cancelled. */
  recording?: { id: string; seconds: number };
  /** The comment being written when recording started, so it can be picked up on whichever page the tab is on. */
  draft?: CarriedDraft;
}

/** A comment being written, carried from page to page while its recording is made. */
export interface CarriedDraft {
  /** The page the comment is on: it's saved there, whichever page the tab is on when it's saved. */
  url: string;
  projectId: string;
  draft: Draft;
  /** The text so far, and the @names picked in it (a TextDraft, with its map as pairs so it can be sent). */
  text: string;
  picked: [string, string][];
  color: string;
  scope: { query: boolean; hash: boolean };
}

/** Messages between the background and the recorder's pages (the bar, the window and the hidden page). */
export type RecorderMessage =
  /** The bar: this tab's recording, if any. */
  | { type: "recorder.status" }
  /** The bar (Chrome): record hidden from the share chosen with desktopCapture. */
  | { type: "recorder.hidden"; streamId: string }
  /** The bar: record in a small window instead. */
  | { type: "recorder.window" }
  /** The bar (Firefox): it opened the sidebar, where the person starts recording. */
  | { type: "recorder.sidebar" }
  /** The sidebar: the tab waiting for it to start, in its browser window (null: none). */
  | { type: "recorder.waiting"; windowId: number }
  /** The bar: stop. */
  | { type: "recorder.stopTab" }
  /** Where it's recorded: it's recording, from `startedAt`. */
  | { type: "recorder.started"; tabId: number; startedAt: number }
  /** Where it's recorded: nothing was recorded (nothing shared, or it couldn't record). */
  | { type: "recorder.failed"; tabId: number; error: string };

/** From the background to the recorder's pages. */
export type RecorderBroadcast =
  /** To the hidden page: record the share `streamId` for the tab. */
  | { type: "offscreen.record"; tabId: number; streamId: string }
  /** To wherever it's recorded: stop the tab's recording. */
  | { type: "recorder.stop"; tabId: number }
  /** To the bars: the tab's recording changed (null: there's none). */
  | { type: "recorder.changed"; tabId: number; state: RecorderState | null };

/** The recorder's pages are extension pages: these messages are only taken from them. */
export const isRecorderMessage = (m: { type?: unknown }): m is RecorderMessage =>
  typeof m.type === "string" &&
  m.type.startsWith("recorder.") &&
  !["recorder.stop", "recorder.changed"].includes(m.type);
