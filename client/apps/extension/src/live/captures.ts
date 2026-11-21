import type { Draft } from "@inklayer/overlay";
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

  /** `on`: whether bug context is on for this server. */
  constructor(on: () => boolean, render: () => void, note: (note: string) => void) {
    this.#on = on;
    this.#render = render;
    this.#note = note;
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

  /** A recording is ready: attach it if a comment is being written (dropping any earlier one), else drop it. Whether it was kept. */
  recordingReady(id: string, seconds: number, writing: boolean): boolean {
    if (!writing) {
      void call({ type: "live.recordingDiscard", recordingId: id }).catch(() => undefined);
      return false;
    }
    this.discardRecording();
    this.#recording = { id, seconds };
    // The recorder has ended the share by now: it can go.
    this.#dock.remove();
    return true;
  }

  /** Closes the recorder's bar: it ends any share first, and goes a moment later (see RecorderDock.close). */
  closeRecorder(): void {
    if (!this.#dock.isOpen) return;
    this.#dock.close();
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
        this.#dock.open();
        this.#render();
      },
      onRecordInWindow: () => {
        this.closeRecorder();
        void call({ type: "live.recordStart" }).catch((e: unknown) => this.#note(messageOf(e)));
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
   * Returns a note saying what didn't work, or null.
   */
  async attach(annotationId: string, draft: Draft, hide: HTMLElement[]): Promise<string | null> {
    const notes: (string | null)[] = [];
    if (this.#on() && this.#pageDetails) {
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
