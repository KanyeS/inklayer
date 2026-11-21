import type { RecorderState } from "../lib/recorder-protocol";
import { MAX_RECORDING_SECONDS, type RecordingSignal } from "../lib/recordings";
import { clock, say, ui } from "./ui";

/**
 * The bar at the bottom of the page: a remote control for the tab's recording, which is made outside the page so it
 * carries on when the person changes pages. Each page shows a new bar, which picks up the recording's state.
 *
 * Start asks what to share. Chrome: from here, with desktopCapture (needs a click here, and the permission the first
 * time), recorded by a hidden page. Elsewhere, or if that fails: in a small window the person starts it from.
 */
/** Firefox's sidebar, which records there (Chrome has none). */
const sidebar = (globalThis as { browser?: { sidebarAction?: { open(): Promise<void> } } }).browser?.sidebarAction;

export function startBar(chooseNow: boolean): void {
  document.body.classList.add("embedded");
  let tabId: number | null = null;
  let state: RecorderState | null = null;
  let tick = 0;

  const send = <T>(message: Record<string, unknown>) =>
    chrome.runtime.sendMessage(message).then((r: { ok: boolean; value?: T; error?: string } | undefined) => {
      if (!r?.ok) throw new Error(r?.error ?? "The extension didn't answer.");
      return r.value as T;
    });

  /** Only redrawn when the state changes, so a message the bar is showing isn't wiped. */
  function showIfChanged(next: RecorderState | null): void {
    if (JSON.stringify(next) !== JSON.stringify(state)) show(next);
  }

  function show(next: RecorderState | null): void {
    state = next;
    clearInterval(tick);
    ui.time.textContent = "";
    ui.draw.hidden = true;
    ui.action.hidden = false;
    ui.action.disabled = false;
    if (state?.phase === "recording") {
      ui.action.textContent = "Stop";
      ui.action.className = "stop";
      ui.draw.hidden = false;
      const startedAt = state.startedAt ?? Date.now();
      const update = () =>
        (ui.time.textContent = clock(Math.floor((Date.now() - startedAt) / 1000), MAX_RECORDING_SECONDS));
      update();
      tick = window.setInterval(update, 250);
      say("");
    } else if (state?.phase === "choosing") {
      ui.action.className = "";
      if (state.mode === "window") {
        ui.action.textContent = "Show the recorder";
        say("Click Start in the recorder window.");
      } else if (state.mode === "sidebar") {
        ui.action.textContent = "Open the sidebar";
        say("Click Start recording in Inklayer's sidebar.");
      } else {
        ui.action.hidden = true;
        say("Choose what to share…");
      }
    } else {
      ui.action.textContent = "Start recording";
      ui.action.className = "";
      say("");
    }
  }

  chrome.runtime.onMessage.addListener(
    (message: { type?: string; tabId?: number; state?: RecorderState | null }, sender) => {
      if (sender.id !== chrome.runtime.id || message?.type !== "recorder.changed") return;
      if (tabId !== null && message.tabId === tabId) showIfChanged(message.state ?? null);
    },
  );

  ui.action.addEventListener("click", () => {
    if (state?.phase === "recording") void send({ type: "recorder.stopTab" }).catch(() => undefined);
    else if (state?.phase === "choosing" && state.mode === "window") void inWindow();
    else if (sidebar) inSidebar();
    else void begin();
  });
  ui.draw.addEventListener("click", () => {
    void chrome.runtime
      .sendMessage({ type: "recording.draw", tabId: null } satisfies RecordingSignal)
      .catch(() => undefined);
  });

  /** Start: what to share, from here (Chrome), else in the small window. */
  async function begin(): Promise<void> {
    let granted = false;
    try {
      // Asked first, while the click still counts. Chrome only; other browsers refuse it, and use the window.
      granted = await chrome.permissions.request({ permissions: ["desktopCapture"] });
    } catch {
      granted = false;
    }
    if (!granted) return inWindow();
    // Just granted: the API shows up when the page loads again (it then asks straight away).
    if (!chrome.desktopCapture) return location.replace(`${location.href}&choose=1`);
    choose();
  }

  function choose(): void {
    ui.action.disabled = true;
    say("Choose what to share…");
    const sources = ["tab", "window", "screen"] as chrome.desktopCapture.DesktopCaptureSourceType[];
    chrome.desktopCapture.chooseDesktopMedia(sources, (streamId) => {
      if (!streamId) {
        show(state);
        return say("Nothing was shared. Start again when you're ready.");
      }
      send({ type: "recorder.hidden", streamId }).catch((e: unknown) => {
        say(`Recording in a small window instead (${e instanceof Error ? e.message : String(e)}).`, true);
        void inWindow();
      });
    });
  }

  /**
   * Firefox: the sidebar records, since it stays while the page changes. Opened from this click (Firefox only opens it
   * from one), and the person clicks Start there (Firefox only shares from a click in the page that records).
   */
  function inSidebar(): void {
    sidebar?.open().catch((e: unknown) => say(e instanceof Error ? e.message : String(e), true));
    void send({ type: "recorder.sidebar" }).catch((e: unknown) =>
      say(e instanceof Error ? e.message : String(e), true),
    );
  }

  async function inWindow(): Promise<void> {
    await send({ type: "recorder.window" }).catch((e: unknown) =>
      say(e instanceof Error ? e.message : String(e), true),
    );
  }

  void send<{ tabId: number | null; state: RecorderState | null }>({ type: "recorder.status" }).then(
    (status) => {
      tabId = status.tabId;
      show(status.state);
      if (chooseNow && !status.state?.phase.match(/choosing|recording/) && chrome.desktopCapture) choose();
    },
    (e: unknown) => say(e instanceof Error ? e.message : String(e), true),
  );
  // Also asked every second: Firefox doesn't pass the background's messages to extension frames in pages.
  setInterval(() => {
    void send<{ tabId: number | null; state: RecorderState | null }>({ type: "recorder.status" })
      .then((status) => {
        tabId = status.tabId;
        showIfChanged(status.state);
      })
      .catch(() => undefined);
  }, 1000);
}
