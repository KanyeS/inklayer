import { copyText } from "@inklayer/overlay";
import type { ComponentChild } from "preact";
import type { LiveProject } from "../lib/live";
import { call, messageOf } from "./call";
import { type SharedLink, shareConfirmBox, sharedBox } from "./views/chrome";

/** "Share this page": a read-only link to this page's comments in `target`, copied to the clipboard if allowed. */
export async function sharePage(target: LiveProject): Promise<SharedLink> {
  const { url, existing, expiresAt } = await call<{ url: string; existing: boolean; expiresAt: string | null }>({
    type: "live.share",
    projectId: target.id,
    url: location.href,
  });
  return { url, existing, expiresAt, projectName: target.name, copied: await copyText(url) };
}

/**
 * The header's share button: first a question saying what making the comments public means, then (on "Create link")
 * the link itself. Clicking the button again while asked closes the question.
 */
export class ShareFlow {
  #asking = false;
  #shared: SharedLink | null = null;

  constructor(
    private readonly render: () => void,
    private readonly note: (text: string) => void,
  ) {}

  ask(): void {
    this.#asking = !this.#asking;
    if (this.#asking) this.#shared = null;
    this.render();
  }

  /** The question or the link, under the header; nothing when neither is open. */
  parts(target: LiveProject | null, busy: boolean): ComponentChild {
    if (this.#asking && target) {
      return shareConfirmBox(
        target.name,
        busy,
        () => void this.#create(target),
        () => this.#close(),
      );
    }
    return this.#shared && sharedBox(this.#shared, () => this.#close());
  }

  async #create(target: LiveProject): Promise<void> {
    this.#asking = false;
    try {
      this.#shared = await sharePage(target);
    } catch (e) {
      this.note(`Couldn't share: ${messageOf(e)}`);
    }
    this.render();
  }

  #close(): void {
    this.#asking = false;
    this.#shared = null;
    this.render();
  }
}
