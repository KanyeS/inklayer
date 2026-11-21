import type { Draft } from "@inklayer/overlay";
import type { RecorderState } from "../lib/recorder-protocol";
import { attachFullPage, attachPageDetails } from "./bug-context";
import { call, messageOf, remember } from "./call";
import { RecorderDock } from "./recorder-dock";
import type { DraftBoxOptions } from "./views/composer";

/**
 * What goes with a new comment besides its text, as chosen in the comment box: the screenshot and page details, a
 * full-page screenshot, and a recording of the tab. The first two choices are remembered for next time.
 */
export class Captures {
  #pageDetails = true;
  #fullPage = false;
  /** A recording made for the comment being written, kept in the extension until it's saved. */
  #recording: { id: string; seconds: number } | null = null;
  /** The recorder's bar at the bottom of the page, while it's open. */
  readonly #dock = new RecorderDock();
  readonly #on: () => boolean;
  readonly #render: () => void;
  readonly #note: (note: string) => void;
  readonly #recordingChosen: () => void;

  /**
   * `on`: whether bug context is on for this server. `recordingChosen`: recording was chosen, so the comment is kept
   * with the tab's recording from now on (it carries on across page changes).
   */
  constructor(on: () => boolean, render: () => void, note: (note: string) => void, recordingChosen: () => void) {
    this.#on = on;
    this.#render = render;
    this.#note = note;
    this.#recordingChosen = recordingChosen;
  }

  /** The tab's recording, picked up on this page: the bar while it records, and the recording once it's made. */
  resume(state: RecorderState): void {
    if (state.phase === "choosing" || state.phase === "recording") this.#dock.open();
    else this.#dock.remove();
    if (state.recording) this.#recording = state.recording;
  }

  /** The recording was dealt with elsewhere (the comment saved or cancelled on another page of the tab). */
  forget(): void {
    this.#dock.remove();
    this.#recording = null;
  }

  /** The recorder is in its bar on the page (not its own window): the panel gets out of the way while it records. */
  get recorderOnPage(): boolean {
    return this.#dock.isOpen;
  }

  /** The choices remembered from last time. */
  restore(stored: Record<string, unknown>): void {
    this.#pageDetails = stored.attachContext !== false;
    this.#fullPage = stored.fullPage === true;
  }

  /**
   * A recording is ready: attach it if a comment is being written (dropping any earlier one). Whether it was attached.
   * Otherwise it's left alone: the background keeps it with the tab until the comment is picked up (this page may not
   * have picked it up yet), and drops it when the tab closes.
   */
  recordingReady(id: string, seconds: number, writing: boolean): boolean {
    if (!writing) return false;
    // Already attached when this page picked up the tab's recording as it loaded.
    if (this.#recording?.id !== id) this.discardRecording();
    this.#recording = { id, seconds };
    // The recorder has ended the share by now: it can go.
    this.#dock.remove();
    return true;
  }

  /** Closes the recorder's bar, stopping the recording (which is then attached, as if stopped from the bar). */
  closeRecorder(): void {
    if (!this.#dock.isOpen) return;
    void call({ type: "live.recorderStop" }).catch(() => undefined);
    this.#dock.remove();
    this.#render();
  }

  discardRecording(): void {
    if (this.#recording)
      void call({ type: "live.recordingDiscard", recordingId: this.#recording.id }).catch(() => undefined);
    this.#recording = null;
  }

  /** The comment box's options for these choices. */
  options(): Pick<
    DraftBoxOptions,
    | "attachContext"
    | "onAttachContext"
    | "fullPage"
    | "onFullPage"
    | "recording"
    | "recorderOpen"
    | "onRecord"
    | "onRecordInWindow"
    | "onCloseRecorder"
    | "onRemoveRecording"
  > {
    const on = this.#on();
    return {
      attachContext: on ? this.#pageDetails : null,
      onAttachContext: (attach) => {
        this.#pageDetails = attach;
        remember({ attachContext: attach });
        this.#render();
      },
      fullPage: on ? this.#fullPage : null,
      onFullPage: (full) => {
        this.#fullPage = full;
        remember({ fullPage: full });
        this.#render();
      },
      recording: on ? (this.#recording ?? undefined) : null,
      recorderOpen: this.#dock.isOpen,
      onRecord: () => {
        // Chrome: the bar asks what to share. Elsewhere a small window opens too, and the bar says to start there.
        this.#recordingChosen();
        this.#dock.open();
        this.#render();
        void call({ type: "live.recordStart" }).catch((e: unknown) => this.#note(messageOf(e)));
      },
      onRecordInWindow: () => {
        this.#recordingChosen();
        this.#dock.open();
        void call({ type: "live.recordInWindow" }).catch((e: unknown) => this.#note(messageOf(e)));
      },
      onCloseRecorder: () => this.closeRecorder(),
      onRemoveRecording: () => {
        this.discardRecording();
        this.#render();
      },
    };
  }

  /**
   * Sends what was chosen with a just-saved comment, with `hide` (Inklayer's own panel and bubbles) out of the screenshots.
   * `here`: the comment is on this page (one carried from another page gets only its recording: this page's screenshot
   * and details would be the wrong page's). Returns a note saying what didn't work, or null.
   */
  async attach(annotationId: string, draft: Draft, hide: HTMLElement[], here = true): Promise<string | null> {
    const notes: (string | null)[] = [];
    if (this.#on() && this.#pageDetails && here) {
      notes.push(await attachPageDetails(annotationId, draft, hide));
      if (this.#fullPage) notes.push(await attachFullPage(annotationId, hide));
    }
    const recording = this.#recording;
    this.#recording = null;
    if (recording) {
      notes.push(
        await call({ type: "live.recordingUpload", annotationId, recordingId: recording.id }).then(
          () => null,
          (e: unknown) => `The recording didn't upload: ${messageOf(e)}`,
        ),
      );
    }
    return notes.find((n) => n !== null) ?? null;
  }
}
