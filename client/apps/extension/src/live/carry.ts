import type { Draft } from "@inklayer/overlay";
import type { CarriedDraft } from "../lib/recorder-protocol";
import { call } from "./call";
import type { TextDraft } from "./suggestions";

/**
 * The comment being written while its recording is made, kept by the background so it can be picked up on whichever
 * page the tab goes to (the recording carries on across page changes). Kept from when recording is chosen until the
 * comment is saved or cancelled: after each change to the text, and as the page goes.
 */
export class Carry {
  /** Keeping the comment with the tab's recording. */
  active = false;
  /** Picked up from another page of the tab: where it's saved. Null when it's this page's own. */
  from: { url: string; projectId: string } | null = null;
  #timer = 0;
  readonly #snapshot: () => Writing | null;

  /** `snapshot`: the comment being written now, if any. */
  constructor(snapshot: () => Writing | null) {
    this.#snapshot = snapshot;
    addEventListener("pagehide", () => this.keepNow());
  }

  /** The page the comment is saved on. */
  get url(): string {
    return this.from?.url ?? location.href;
  }

  start(): void {
    this.active = true;
    this.keepNow();
  }

  /** After typing: kept a moment later, once. */
  keepSoon(): void {
    if (!this.active) return;
    clearTimeout(this.#timer);
    this.#timer = window.setTimeout(() => this.keepNow(), 400);
  }

  keepNow(): void {
    if (!this.active) return;
    clearTimeout(this.#timer);
    const now = this.#snapshot();
    // Nothing to keep here (yet): what's kept stays. It's only let go by saving or cancelling (clear).
    if (!now) return;
    const projectId = this.from?.projectId ?? now.projectId;
    const draft = carried(this.url, projectId, now.draft, now.text, now.color, now.scope);
    void call({ type: "live.recorderDraft", draft }).catch(() => undefined);
  }

  /** Saved or cancelled: any recording stops, and nothing is kept. */
  clear(): void {
    const was = this.active || this.from !== null;
    this.drop();
    if (was) void call({ type: "live.recorderClear" }).catch(() => undefined);
  }

  /** The comment kept with the tab's recording, picked up on this page (it's saved on its own page, maybe not this). */
  pickUp(kept: CarriedDraft): Omit<Writing, "projectId"> {
    this.from = kept.url === location.href ? null : { url: kept.url, projectId: kept.projectId };
    return { draft: kept.draft, text: textOf(kept), color: kept.color, scope: kept.scope };
  }

  /**
   * The address changed without a page load (single-page sites). A comment being recorded stays, still on the page it
   * was started on (`from`); back at that address, it's that page's own again. Whether it stays.
   */
  moved(from: string, projectId: string, drafting: boolean): boolean {
    if (!this.active || !drafting) return false;
    this.from ??= { url: from, projectId };
    if (this.from.url === location.href) this.from = null;
    this.keepNow();
    return true;
  }

  /** To the comment's own page, with the comment as it is now kept to pick up there. */
  goBack(): void {
    if (!this.from) return;
    this.keepNow();
    location.assign(this.from.url);
  }

  /** Stops keeping it here, leaving what's kept alone (it was dealt with on another page). */
  drop(): void {
    this.active = false;
    this.from = null;
    clearTimeout(this.#timer);
  }
}

/** The comment being written, as the panel has it. */
export interface Writing {
  draft: Draft;
  text: TextDraft;
  color: string;
  scope: { query: boolean; hash: boolean };
  projectId: string;
}

export function carried(
  url: string,
  projectId: string,
  draft: Draft,
  text: TextDraft,
  color: string,
  scope: { query: boolean; hash: boolean },
): CarriedDraft {
  return { url, projectId, draft, text: text.text, picked: [...text.picked], color, scope };
}

export function textOf(carried: CarriedDraft): TextDraft {
  return { text: carried.text, picked: new Map(carried.picked) };
}

/** What's left of the page's address once a comment's scope is chosen, for the page it's on (maybe not this one). */
export function scopeFor(url: string, scope: { query: boolean; hash: boolean }) {
  const page = new URL(url);
  return { includeQuery: scope.query && page.search.length > 1, includeHash: scope.hash && page.hash.length > 1 };
}
