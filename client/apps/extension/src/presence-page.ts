import { type Anchor, type CursorPosition, cursorPositionAt, PresenceLayer, selectionAnchor } from "@inklayer/overlay";
import { PRESENCE_PORT, type PresenceDown, type PresenceUp } from "./lib/presence-protocol";

/**
 * Live presence on this page, when the user turned it on for the tab: sends this person's pointer and selection, and
 * draws everyone else's. Talks only to the background worker, over a port; the background turns the address into a
 * hash and relays to the server.
 */

const CURSOR_EVERY_MS = 50; // at most 20 updates a second
const SELECTION_DELAY_MS = 150;
const RECONNECT_PORT_MS = 1_000;

export class PresenceClient {
  readonly #isOwn: (el: Element) => boolean;
  #layer: PresenceLayer | null = null;
  #port: chrome.runtime.Port | null = null;
  #href = "";
  #pointer: { x: number; y: number } | null = null;
  #cursorTimer = 0;
  #lastCursorAt = 0;
  #selectionTimer = 0;
  #sentSelection = false;
  #watch = 0;
  #observer: MutationObserver | null = null;
  #reanchorTimer = 0;
  #listeners: (() => void)[] = [];

  /** @param ownElements Inklayer's own elements on the page (the panel), which aren't pointed at or selected. */
  constructor(ownElements: () => Element[] = () => []) {
    this.#isOwn = (el) => this.#layer?.owns(el) === true || ownElements().some((own) => own === el || own.contains(el));
  }

  get running(): boolean {
    return this.#layer !== null;
  }

  start(): void {
    if (this.#layer) return;
    this.#layer = new PresenceLayer(document);
    this.#connect();

    this.#on(document, "pointermove", (e) => {
      this.#pointer = { x: e.clientX, y: e.clientY };
      this.#queueCursor();
    });
    this.#on(window, "scroll", () => {
      if (this.#pointer) this.#queueCursor();
    });
    this.#on(document.documentElement, "pointerleave", () => this.#post({ t: "idle" }));
    this.#on(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") this.#post({ t: "idle" });
    });
    this.#on(document, "selectionchange", () => {
      clearTimeout(this.#selectionTimer);
      this.#selectionTimer = window.setTimeout(() => this.#sendSelection(), SELECTION_DELAY_MS);
    });

    // Single-page apps change the address without reloading: join the new page.
    this.#href = location.href;
    this.#watch = window.setInterval(() => {
      this.#layer?.ensureAttached();
      if (location.href !== this.#href) {
        this.#href = location.href;
        this.#layer?.setPeers([]);
        this.#post({ t: "join", url: location.href });
      }
    }, 1000);

    // The page's DOM changed: find the elements people point at again, but not on every mutation.
    this.#observer = new MutationObserver(() => {
      clearTimeout(this.#reanchorTimer);
      this.#reanchorTimer = window.setTimeout(() => this.#layer?.reanchor(), 400);
    });
    if (document.body) this.#observer.observe(document.body, { childList: true, subtree: true });
  }

  stop(): void {
    if (!this.#layer) return;
    for (const off of this.#listeners) off();
    this.#listeners = [];
    clearInterval(this.#watch);
    clearTimeout(this.#cursorTimer);
    clearTimeout(this.#selectionTimer);
    clearTimeout(this.#reanchorTimer);
    this.#observer?.disconnect();
    const port = this.#port;
    this.#port = null;
    port?.disconnect();
    this.#layer.destroy();
    this.#layer = null;
  }

  /** The DOM changed under the comments overlay too; share its timing. */
  reanchor(): void {
    this.#layer?.reanchor();
  }

  #connect(): void {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: PRESENCE_PORT });
    } catch {
      this.#layer?.setStatus("offline", "Reload the page to go live again");
      return;
    }
    this.#port = port;
    port.onMessage.addListener((message: PresenceDown) => this.#onMessage(message));
    port.onDisconnect.addListener(() => {
      if (this.#port !== port) return; // stopped on purpose
      this.#port = null;
      this.#layer?.setPeers([]);
      this.#layer?.setStatus("connecting");
      // The background was restarted, or presence was turned off: ask before reconnecting.
      window.setTimeout(() => void this.#reconnect(), RECONNECT_PORT_MS);
    });
    port.postMessage({ t: "join", url: location.href } satisfies PresenceUp);
  }

  async #reconnect(): Promise<void> {
    if (!this.#layer) return;
    let on = false;
    try {
      const response = (await chrome.runtime.sendMessage({ type: "presence.status" })) as
        | { ok: boolean; value?: boolean }
        | undefined;
      on = response?.ok === true && response.value === true;
    } catch {
      this.#layer.setStatus("offline", "Reload the page to go live again");
      return;
    }
    if (on) this.#connect();
    else this.stop();
  }

  #onMessage(message: PresenceDown): void {
    const layer = this.#layer;
    if (!layer) return;
    switch (message.t) {
      case "status":
        layer.setStatus(message.status, message.error);
        break;
      case "peers":
        layer.setPeers(message.peers);
        // Newcomers should see this person's selection straight away.
        this.#sentSelection = false;
        this.#sendSelection();
        break;
      case "peerJoin":
        layer.addPeer(message.peer);
        if (this.#sentSelection) {
          this.#sentSelection = false;
          this.#sendSelection();
        }
        break;
      case "peerLeave":
        layer.removePeer(message.id);
        break;
      case "cursor":
        layer.moveCursor(message.id, message.data as CursorPosition);
        break;
      case "select":
        layer.setSelection(message.id, message.data as Anchor | null);
        break;
      case "idle":
        layer.setIdle(message.id);
        break;
    }
  }

  #queueCursor(): void {
    if (this.#cursorTimer) return;
    const wait = Math.max(0, CURSOR_EVERY_MS - (Date.now() - this.#lastCursorAt));
    this.#cursorTimer = window.setTimeout(() => {
      this.#cursorTimer = 0;
      this.#lastCursorAt = Date.now();
      if (this.#pointer)
        this.#post({ t: "cursor", data: cursorPositionAt(document, this.#pointer.x, this.#pointer.y, this.#isOwn) });
    }, wait);
  }

  #sendSelection(): void {
    const anchor = selectionAnchor(document, this.#isOwn);
    if (!anchor && !this.#sentSelection) return;
    this.#sentSelection = anchor !== null;
    this.#post({ t: "select", data: anchor });
  }

  #post(message: PresenceUp): void {
    try {
      this.#port?.postMessage(message);
    } catch {
      // The port closed; onDisconnect reconnects.
    }
  }

  #on<K extends keyof DocumentEventMap>(target: Document, type: K, listener: (e: DocumentEventMap[K]) => void): void;
  #on<K extends keyof WindowEventMap>(target: Window, type: K, listener: (e: WindowEventMap[K]) => void): void;
  #on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (e: HTMLElementEventMap[K]) => void,
  ): void;
  #on(target: EventTarget, type: string, listener: (e: Event) => void): void {
    target.addEventListener(type, listener, { passive: true });
    this.#listeners.push(() => target.removeEventListener(type, listener));
  }
}
