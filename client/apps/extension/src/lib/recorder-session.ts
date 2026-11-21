import type { CarriedDraft, RecorderBroadcast, RecorderMessage, RecorderState } from "./recorder-protocol";
import { discardRecording } from "./recordings";

/**
 * Each tab's recording, kept by the background in session storage (the service worker can stop between messages).
 * The recording is made outside the page, so the person can go to other pages, reload, and go back and forward while
 * it records: each page asks for the tab's state when it loads and shows the bar and the comment being written.
 *
 * - Chrome: the bar on the page asks the person what to share (desktopCapture, from a click in the bar), and a hidden
 *   extension page (an offscreen document) records it.
 * - Firefox (and Chrome when that fails): a small window, where the person clicks Start; it minimises once recording.
 */

const KEY = "inklayer.recorder.";
const OFFSCREEN = "offscreen.html";
/** The small window's size, when it's needed. */
const WINDOW = { width: 400, height: 280 } as const;

export async function recorderState(tabId: number): Promise<RecorderState | null> {
  const key = KEY + tabId;
  const stored = (await chrome.storage.session.get(key))[key] as RecorderState | undefined;
  return stored ?? null;
}

/** Every tab's state. */
async function allStates(): Promise<RecorderState[]> {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([key]) => key.startsWith(KEY))
    .map(([, state]) => state as RecorderState);
}

async function save(state: RecorderState): Promise<void> {
  await chrome.storage.session.set({ [KEY + state.tabId]: state });
  changed(state.tabId, state);
}

async function forget(tabId: number): Promise<void> {
  await chrome.storage.session.remove(KEY + tabId);
  changed(tabId, null);
}

/** Tells the bars (every page of the extension hears it; each bar keeps to its own tab). */
function changed(tabId: number, state: RecorderState | null): void {
  broadcast({ type: "recorder.changed", tabId, state });
}

function broadcast(message: RecorderBroadcast): void {
  void chrome.runtime.sendMessage(message).catch(() => undefined); // nobody listening is fine
}

/** Tells the tab's page; a page that's still loading asks for the state itself. */
function tell(tabId: number, message: Record<string, unknown>): void {
  void chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

/** Whether this browser can record from a hidden page (Chrome's offscreen documents). */
export function canRecordHidden(): boolean {
  return typeof chrome.offscreen?.createDocument === "function";
}

/** Whether this browser has Inklayer's sidebar to record from (Firefox). */
export function canRecordInSidebar(): boolean {
  const firefox = (globalThis as { browser?: { sidebarAction?: { open?: unknown } } }).browser;
  return typeof firefox?.sidebarAction?.open === "function";
}

/** The bar opened the sidebar: the tab waits there for the person to start recording. */
async function startSidebar(tabId: number, windowId: number | undefined): Promise<void> {
  const previous = await recorderState(tabId);
  await save({ ...previous, tabId, phase: "choosing", mode: "sidebar", windowId, startedAt: undefined });
}

/** The tab in `windowId` whose recording the sidebar there should start, if any. */
async function waitingIn(windowId: number): Promise<number | null> {
  const waiting = (await allStates()).find(
    (s) => s.mode === "sidebar" && s.phase === "choosing" && s.windowId === windowId,
  );
  return waiting?.tabId ?? null;
}

/* -------------------------------------------------------------- starting */

/**
 * Records `streamId` (chosen in the bar) in the hidden page. Throws if it can't, and the bar falls back to the window.
 */
async function startHidden(tabId: number, streamId: string): Promise<void> {
  if (!canRecordHidden()) throw new Error("This browser can't record from a hidden page.");
  const previous = await recorderState(tabId);
  await save({ ...previous, tabId, phase: "choosing", mode: "hidden", windowId: undefined, startedAt: undefined });
  try {
    if (!(await chrome.offscreen.hasDocument()))
      await chrome.offscreen.createDocument({
        url: OFFSCREEN,
        reasons: ["DISPLAY_MEDIA", "USER_MEDIA"],
        justification: "Records the tab the person chose, so recording carries on when they change pages.",
      });
    const reply = (await chrome.runtime.sendMessage({ type: "offscreen.record", tabId, streamId })) as
      | { ok: boolean; error?: string }
      | undefined;
    if (!reply?.ok) throw new Error(reply?.error ?? "The recorder didn't answer.");
  } catch (e) {
    await failed(tabId);
    throw e;
  }
}

/** Opens the small window to record from (it records `tabId`). */
export async function startWindow(tabId: number): Promise<void> {
  const previous = await recorderState(tabId);
  if (previous?.mode === "window" && previous.windowId !== undefined && previous.phase !== "done") {
    // Already open: bring it back.
    await chrome.windows.update(previous.windowId, { focused: true, state: "normal" }).catch(() => undefined);
    return;
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`recorder.html?tab=${tabId}`),
    type: "popup",
    ...WINDOW,
  });
  await save({ ...previous, tabId, phase: "choosing", mode: "window", windowId: created?.id, startedAt: undefined });
}

/** Where it's recorded says it's recording: the pages show it, and the window gets out of the way. */
async function started(tabId: number, startedAt: number): Promise<void> {
  const state = await recorderState(tabId);
  if (!state) return;
  await save({ ...state, phase: "recording", startedAt });
  tell(tabId, { type: "inklayer.recordingState", recording: true });
  if (state.mode === "window" && state.windowId !== undefined)
    await chrome.windows.update(state.windowId, { state: "minimized" }).catch(() => undefined);
}

/** Nothing was recorded: back to no recording (the comment being written stays with the page that has it). */
async function failed(tabId: number): Promise<void> {
  const state = await recorderState(tabId);
  if (state?.draft)
    await save({ tabId, phase: "done", mode: state.mode, draft: state.draft, recording: state.recording });
  else await forget(tabId);
  tell(tabId, { type: "inklayer.recordingState", recording: false });
  await closeHiddenIfIdle();
}

/* -------------------------------------------------------------- finishing */

/** A recording is ready: kept with the tab's state and given to the page that's open now. */
export async function recordingDone(tabId: number, recordingId: string, seconds: number): Promise<void> {
  const state = await recorderState(tabId);
  if (state?.recording && state.recording.id !== recordingId) void discardRecording(state.recording.id);
  await save({
    ...(state ?? { tabId, mode: "hidden" }),
    tabId,
    phase: "done",
    windowId: undefined,
    recording: { id: recordingId, seconds },
  });
  tell(tabId, { type: "inklayer.recordingState", recording: false });
  tell(tabId, { type: "inklayer.recording", recordingId, seconds });
  await closeHiddenIfIdle();
}

export function stopRecording(tabId: number): void {
  broadcast({ type: "recorder.stop", tabId });
}

/** Stop from the bar or the comment box: ends the recording (it's then kept), or gives up choosing what to share. */
export async function stopTab(tabId: number): Promise<void> {
  const state = await recorderState(tabId);
  if (state?.phase === "choosing") {
    if (state.mode === "window" && state.windowId !== undefined)
      await chrome.windows.remove(state.windowId).catch(() => undefined);
    await failed(tabId);
  } else stopRecording(tabId);
}

/** The hidden page goes once nothing is recorded in it. */
async function closeHiddenIfIdle(): Promise<void> {
  if (!canRecordHidden()) return;
  const busy = (await allStates()).some(
    (s) => s.mode === "hidden" && (s.phase === "choosing" || s.phase === "recording"),
  );
  if (!busy && (await chrome.offscreen.hasDocument())) await chrome.offscreen.closeDocument().catch(() => undefined);
}

/* -------------------------------------------------------------- the comment being written */

/** Keeps the comment being written with the tab's recording, or (null) lets it go. */
export async function keepDraft(tabId: number, draft: CarriedDraft | null): Promise<void> {
  const state = await recorderState(tabId);
  if (!state) {
    if (draft) await save({ tabId, phase: "done", mode: canRecordHidden() ? "hidden" : "window", draft });
    return;
  }
  await save({ ...state, draft: draft ?? undefined });
}

/** The comment was saved or cancelled: stop any recording and forget it all. The page uploads or discards the video. */
export async function clearRecorder(tabId: number): Promise<void> {
  const state = await recorderState(tabId);
  if (!state) return;
  if (state.phase === "recording" || state.phase === "choosing") {
    stopRecording(tabId);
    if (state.mode === "window" && state.windowId !== undefined && state.phase === "choosing")
      await chrome.windows.remove(state.windowId).catch(() => undefined);
  }
  await forget(tabId);
  tell(tabId, { type: "inklayer.recordingState", recording: false });
}

/** Whether `url` is the page of the comment carried with the tab's recording (it may be saved from another page). */
export async function isCarriedPage(tabId: number, url: string): Promise<boolean> {
  return (await recorderState(tabId))?.draft?.url === url;
}

/* -------------------------------------------------------------- messages and cleaning up */

/** A message from one of the recorder's pages: the bar (in a tab), the window, or the hidden page. */
export async function handleRecorder(
  message: RecorderMessage,
  senderTabId: number | undefined,
  senderWindowId: number | undefined,
): Promise<unknown> {
  switch (message.type) {
    case "recorder.status":
      return { tabId: senderTabId ?? null, state: senderTabId === undefined ? null : await recorderState(senderTabId) };
    case "recorder.hidden":
      if (senderTabId === undefined) throw new Error("Unknown tab.");
      await startHidden(senderTabId, message.streamId);
      return null;
    case "recorder.window":
      if (senderTabId === undefined) throw new Error("Unknown tab.");
      await startWindow(senderTabId);
      return null;
    case "recorder.sidebar":
      if (senderTabId === undefined) throw new Error("Unknown tab.");
      await startSidebar(senderTabId, senderWindowId);
      return null;
    case "recorder.waiting":
      return waitingIn(message.windowId);
    case "recorder.stopTab":
      if (senderTabId !== undefined) await stopTab(senderTabId);
      return null;
    case "recorder.started":
      await started(message.tabId, message.startedAt);
      return null;
    case "recorder.failed":
      await failed(message.tabId);
      return null;
  }
}

/** A closed tab: stop its recording and drop what was kept. A closed recorder window: its recording is over. */
export function watchRecorderTabs(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void recorderState(tabId).then(async (state) => {
      if (!state) return;
      stopRecording(tabId);
      if (state.recording) await discardRecording(state.recording.id).catch(() => undefined);
      await forget(tabId);
      if (state.mode === "window" && state.windowId !== undefined)
        await chrome.windows.remove(state.windowId).catch(() => undefined);
    });
  });
  chrome.windows.onRemoved.addListener((windowId) => {
    void allStates().then(async (states) => {
      for (const state of states) if (state.windowId === windowId && state.phase !== "done") await failed(state.tabId);
    });
  });
}
