import {
  BubbleLayer, Overlay, commentParts, commentToOpen, decodeMentions, encodeMentions, resolveElement, resolveRange, type Anchor, type AnchorQuality, type AnnotationKind, type Draft, type Geometry, type OverlayAnnotation, type OverlayMessage, type Tool,
} from "@inklayer/overlay";
import type { ActivityItem, ActivityPage, DocLookup, LiveAnnotation, LiveInit, LivePage, LiveProject, LiveReply, LiveRequest, PageContext, PersonLookup, TrackerChoice } from "./lib/live";
import type { Inbox, InboxItem } from "./lib/notifications";
import { browserOf, elementHtml, osOf, screenshotArea, type Rect } from "./lib/pageDetails";
import { clampPosition, DEFAULT_POSITION, parsePosition, type PanelPosition } from "./lib/panelPosition";
import { sizeDiffers, windowSizeFor } from "./lib/viewportMatch";
import type { Response } from "./lib/messages";
import themeTokens from "@inklayer/ui/tokens.css?inline";
import { personTitle } from "./lib/people";
import { PresenceClient } from "./presence-page";

type View = "comments" | "activity" | "inbox";

/** The activity log as shown in the panel: loaded only when the Activity tab is opened. */
interface ActivityState {
  items: ActivityItem[];
  kinds: ActivityItem["kind"][];
  nextBefore: string | null;
  thisSite: boolean;
  kind: ActivityItem["kind"] | null;
  loading: boolean;
  error: string;
}

const ACTIVITY_VERBS: Record<string, string> = {
  created: "commented",
  updated: "edited a comment",
  resolved: "resolved a comment",
  reopened: "reopened a comment",
  deleted: "deleted a comment",
  signed_in: "signed in",
  sign_in_refused: "Sign-in refused",
  error: "Server error",
  replied: "replied to a comment",
};
const DOC_VERBS: Record<string, string> = {
  created: "created a doc",
  edited: "edited a doc",
  renamed: "renamed a doc",
  moved: "moved a doc",
  deleted: "deleted a doc",
};
const INBOX_TEXT: Record<string, string> = {
  mention: "mentioned you",
  reply: "replied",
  resolved: "resolved your comment",
  issue_closed: "An issue for your comment was closed",
};

const KIND_LABELS: Record<ActivityItem["kind"], string> = { comments: "Comments", docs: "Docs", signins: "Sign-ins", errors: "Errors" };

/** A comment on this page, and the project it belongs to. */
type PageAnnotation = LiveAnnotation & { projectId: string };

/**
 * Live mode on a real page. The script loads on every http(s) page but stays invisible unless the site has comments
 * (the background checks only the origin) or the user chooses "Comment on this page" in the toolbar popup.
 * <ul>
 * <li>Draws the comments for this page from all of the user's projects with the shared overlay, re-anchored to the page's current DOM.</li>
 * <li>Adds a small panel, in a closed shadow root, for the tools and the comment list.</li>
 * <li>All API calls go through the background worker, which checks them against this page's origin; the page never sees a token.</li>
 * </ul>
 * Everything shown is set with textContent, never parsed as HTML.
 */

declare global {
  // eslint-disable-next-line no-var
  var __inklayerLive: boolean | undefined;
}

const COLORS = ["#f59e0b", "#ef4444", "#3b82f6", "#10b981", "#8b5cf6"];
const TOOLS: { tool: Tool; label: string; title: string }[] = [
  { tool: "select", label: "Select", title: "Select comments" },
  { tool: "pin", label: "Pin", title: "Pin a comment to a point" },
  { tool: "element", label: "Element", title: "Outline an element" },
  { tool: "highlight", label: "Text", title: "Highlight text (select it with the mouse)" },
  { tool: "rect", label: "Box", title: "Draw a box" },
  { tool: "arrow", label: "Arrow", title: "Draw an arrow" },
  { tool: "ink", label: "Draw", title: "Draw freehand" },
];
/** Which parts of the address a new comment belongs to. Origin and path always; the query and #hash if the commenter chooses. */
interface Scope {
  query: boolean;
  hash: boolean;
}

/** The path as the server keys it: without a trailing slash, except for the root. */
function pagePath(url: URL): string {
  return url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") || "/" : url.pathname;
}

/** The choices for where a new comment on this page belongs. Only one if the address has no query or #hash. */
function scopeOptions(): { scope: Scope; label: string; address: string }[] {
  const url = new URL(location.href);
  const path = pagePath(url);
  const query = url.search.length > 1 ? url.search : "";
  const hash = url.hash.length > 1 ? url.hash : "";
  const options = [{ scope: { query: false, hash: false }, label: "Any version of this page", address: path }];
  if (query) options.push({ scope: { query: true, hash: false }, label: "Only this address", address: path + query });
  if (hash) options.push({ scope: { query: !!query, hash: true }, label: query ? "Only this address and #hash" : "Only this #hash", address: path + query + hash });
  return options;
}

/** Where an existing comment belongs, for its list entry, e.g. "/watch (any version)" or "/watch?v=…". */
function addressOf(pageUrl: string | null): string {
  if (!pageUrl) return "";
  try {
    const url = new URL(pageUrl);
    return url.search || url.hash ? pagePath(url) + url.search + url.hash : `${pagePath(url)} (any version)`;
  } catch {
    return pageUrl;
  }
}

const REANCHOR_DELAY_MS = 400;
const REANCHOR_MAX_WAIT_MS = 1500;
const REFRESH_EVERY_MS = 60_000;

async function call<T>(request: LiveRequest): Promise<T> {
  let response: Response<T> | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  } catch {
    throw new Error("Inklayer was updated or restarted. Reload this page to keep commenting.");
  }
  if (!response) throw new Error("Inklayer didn't answer. Reload this page.");
  if (!response.ok) throw new Error(response.notSignedIn ? "You're signed out of Inklayer. Sign in from the toolbar button." : response.error);
  return response.value;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const units: [number, string][] = [[60, "m"], [3600, "h"], [86400, "d"], [604800, "w"]];
  let label = "";
  for (const [size, unit] of units) if (seconds >= size) label = `${Math.floor(seconds / size)}${unit} ago`;
  return label;
}

class LiveSession {
  readonly #init: LiveInit;
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  readonly #root: HTMLDivElement;
  readonly #overlay: Overlay;

  readonly #projects: Map<string, LiveProject>;
  /** Where new comments go: a project the user can comment in, or null if they can only view. */
  #target: LiveProject | null;
  #annotations: PageAnnotation[] = [];
  #quality: Record<string, AnchorQuality> = {};
  #draft: Draft | null = null;
  #draftInput: HTMLTextAreaElement | null = null;
  #editing: { id: string; input: HTMLTextAreaElement } | null = null;
  #selected: string | null = null;
  #tool: Tool = "select";
  #color = COLORS[0]!;
  #scope: Scope = { query: false, hash: false };
  #open = false;
  #view: View = "comments";
  #activity: ActivityState | null = null;
  #marksVisible = true;
  /** Attach a screenshot and page details to new comments (remembered; on unless turned off). */
  #attachContext = true;
  readonly #bubbles: BubbleLayer;
  /** The comment whose mark the pointer is on, shown in a bubble until it leaves. */
  #hoverId: string | null = null;
  /** Bubbles kept open with the pin button. */
  readonly #pinned = new Set<string>();
  /** Every comment's bubble open, not just on hover (the user's choice, remembered). */
  #bubblesOpen = false;
  /** Where the panel was dragged to; the same on every site. */
  #position: PanelPosition = DEFAULT_POSITION;
  /** Unread notifications, kept up to date by the background's once-a-minute check (via storage). */
  #unread = 0;
  /** The inbox, loaded when it's opened. */
  #inbox: { data: Inbox | null; loading: boolean; error: string } | null = null;
  /** Pinned (the default): the panel stays where it is. Unpin it to drag it somewhere else. */
  #panelPinned = true;
  /** Set when a drag of the collapsed button ends, so it doesn't also open the panel. */
  #dragged = false;
  /** What happened to the last "Share this page", shown under the header. */
  #shareNote = "";
  /** This window was resized to a commenter's size; "Back to my size" puts it back. The size shown, if known. */
  #sizeMatched: { width: number; height: number | null } | "unknown" | null = null;
  /** The last "Share this page" link, shown until closed. */
  #shared: { url: string; existing: boolean; expiresAt: string | null; projectName: string; copied: boolean } | null = null;
  #inBubble = false;
  /** Which marks have positions; cards are rebuilt only when this changes, not on every move. */
  #markIds = "";
  #hideTimer = 0;
  /** Reply boxes, kept across re-renders so typing isn't lost. Keyed by place ("bubble:" or "panel:") and comment id. */
  readonly #replyInputs = new Map<string, HTMLTextAreaElement>();
  /** Each project's connected issue trackers, loaded the first time a comment there is shown. */
  readonly #trackers = new Map<string, TrackerChoice[] | "loading">();
  #showResolved = false;
  #busy = false;
  #error = "";
  #href = location.href;
  #reanchorTimer = 0;
  #reanchorSince = 0;

  constructor(init: LiveInit) {
    this.#init = init;
    this.#projects = new Map(init.projects.map((p) => [p.id, p]));
    const commentable = init.projects.filter((p) => p.canComment);
    this.#target = commentable.find((p) => p.id === init.lastProjectId) ?? commentable[0] ?? null;
    this.#setPages(init.pages);

    this.#host = document.createElement("inklayer-live");
    this.#host.setAttribute("style", "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;");
    this.#shadow = this.#host.attachShadow({ mode: "closed" });
    this.#shadow.innerHTML = `<style>${STYLES}</style>`;
    followColorScheme(this.#host);
    void loadPanelFont();
    this.#root = document.createElement("div");
    this.#root.className = "root";
    this.#shadow.append(this.#root);
    // Typing in the panel shouldn't trigger the page's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"] as const) this.#root.addEventListener(type, (e) => e.stopPropagation());

    this.#bubbles = new BubbleLayer(STYLES, () => {
      this.#inBubble = true;
      clearTimeout(this.#hideTimer);
    }, () => {
      this.#inBubble = false;
      this.#scheduleHide();
    });
    followColorScheme(this.#bubbles.host);
    this.#overlay = new Overlay(document, (m) => this.#onOverlay(m), { ignoreEventsFrom: [this.#host, this.#bubbles.host] });
    void chrome.storage.local.get(["bubblesOpen", "attachContext", "panelPosition", "panelPinned", "unreadCount"]).then((stored) => {
      this.#unread = typeof stored.unreadCount === "number" ? stored.unreadCount : 0;
      this.#panelPinned = stored.panelPinned !== false;
      this.#bubblesOpen = stored.bubblesOpen === true;
      this.#attachContext = stored.attachContext !== false;
      this.#position = parsePosition(stored.panelPosition) ?? DEFAULT_POSITION;
      this.#placePanel();
      this.#render();
    }).catch(() => undefined);
    document.documentElement.append(this.#host);
    // Moved elsewhere (or another tab moved it): follow. Window resized: stay inside it.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.unreadCount) {
        this.#unread = typeof changes.unreadCount.newValue === "number" ? changes.unreadCount.newValue : 0;
        if (this.#view === "inbox" && this.#inbox && !this.#inbox.loading) void this.#loadInbox();
        else this.#render();
      }
      if (changes.panelPinned) {
        this.#panelPinned = changes.panelPinned.newValue !== false;
        this.#render();
      }
      if (changes.panelPosition) {
        this.#position = parsePosition(changes.panelPosition.newValue) ?? DEFAULT_POSITION;
        this.#placePanel();
      }
    });
    // Resized: stay inside the window, and redraw once it settles, since "Made at …px wide" depends on the width.
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      this.#placePanel();
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => this.#render(), 200);
    });
    // After a reload: was this window resized to someone's size?
    void call<boolean>({ type: "live.sizeSaved" }).then((saved) => {
      if (!saved) return;
      this.#sizeMatched = "unknown";
      this.#render();
    }).catch(() => undefined);
  }

  /** Puts the panel at its position, kept inside the window. */
  #placePanel(): void {
    const box = this.#host.getBoundingClientRect();
    const placed = clampPosition(this.#position, { width: box.width, height: box.height }, { width: innerWidth, height: innerHeight });
    this.#host.style.right = `${placed.right}px`;
    this.#host.style.bottom = `${placed.bottom}px`;
  }

  /**
   * Drags the panel by its header (tabs and icons included) or the collapsed button; the new place is remembered for every
   * site. A press that doesn't move is still a click. While pinned, a drag only explains how to move it.
   */
  #startDrag(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as Element).closest("select, input, textarea")) return;
    const handle = e.currentTarget as HTMLElement;
    const box = this.#host.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, right: innerWidth - box.right, bottom: innerHeight - box.bottom };
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved) {
        if (Math.hypot(dx, dy) < 5) return; // still a click
        moved = true;
        if (this.#panelPinned) {
          end();
          // The collapsed button can't show a note; the open panel can.
          if (!handle.classList.contains("launcher")) this.#flashNote("Pinned in place. Click the pin icon to unpin, then drag the header to move the panel.");
          return;
        }
        // Captured only once it's a drag, so plain clicks still reach the button pressed.
        handle.setPointerCapture(ev.pointerId);
        handle.classList.add("dragging");
      }
      this.#position = clampPosition({ right: start.right - dx, bottom: start.bottom - dy }, { width: box.width, height: box.height }, { width: innerWidth, height: innerHeight });
      this.#host.style.right = `${this.#position.right}px`;
      this.#host.style.bottom = `${this.#position.bottom}px`;
    };
    const end = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      handle.classList.remove("dragging");
      if (!moved || this.#panelPinned) return;
      // The release after a drag isn't a click on whatever is under it.
      this.#dragged = true;
      window.setTimeout(() => (this.#dragged = false), 0);
      void chrome.storage.local.set({ panelPosition: this.#position }).catch(() => undefined);
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  }

  /** A short message under the header (sharing results, how to move the panel). */
  #flashNote(text: string): void {
    this.#shareNote = text;
    this.#render();
    window.setTimeout(() => {
      if (this.#shareNote !== text) return;
      this.#shareNote = "";
      this.#render();
    }, 8000);
  }

  /** The pin, on the panel's top-right corner like a pushpin: pinned keeps the panel in place; unpinned, the header drags it. */
  #cornerPin(): HTMLButtonElement {
    return h("button", { className: this.#panelPinned ? "corner-pin on" : "corner-pin", ariaPressed: String(this.#panelPinned),
      title: this.#panelPinned ? "Pinned in place. Click to unpin, then drag the header to move the panel." : "Unpinned: drag the header to move the panel (double-click it to put it back in the corner). Click to pin it here.",
      onclick: () => this.#setPinned(!this.#panelPinned) }, this.#panelPinned ? pinIcon() : pinOffIcon());
  }

  #setPinned(pinned: boolean): void {
    this.#panelPinned = pinned;
    void chrome.storage.local.set({ panelPinned: pinned }).catch(() => undefined);
    this.#render();
  }

  /** Back to the bottom-right corner (double-click the header while unpinned). */
  #resetPosition(): void {
    this.#position = DEFAULT_POSITION;
    this.#placePanel();
    void chrome.storage.local.set({ panelPosition: DEFAULT_POSITION }).catch(() => undefined);
  }

  /** Opens the panel on one comment, e.g. from "Open on the page" in the web viewer. */
  focusComment(id: string): void {
    this.#open = true;
    this.#view = "comments";
    const annotation = this.#annotations.find((a) => a.id === id);
    if (!annotation) {
      this.#error = "That comment isn't on this version of the page, or was deleted.";
      this.#render();
      return;
    }
    if (annotation.status === "Resolved") this.#showResolved = true;
    this.#selected = id;
    this.#syncOverlay();
    this.#overlay.handle({ type: "select", id, scroll: true });
    this.#render();
    this.#root.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  /** Expands the panel, e.g. when the user picks "Comment on this page" in the toolbar. */
  open(view: View = "comments"): void {
    this.#open = true;
    this.#setView(view);
  }

  async start(open: boolean, view: View = "comments"): Promise<void> {
    this.#open = open;
    if (open && view === "activity") this.#setView(view);
    this.#syncOverlay();
    this.#render();

    // Single-page apps change the URL without reloading; some also replace parts of html.
    setInterval(() => {
      if (this.#overlay.ensureAttached() || !this.#host.isConnected) document.documentElement.append(this.#host);
      this.#bubbles.ensureAttached();
      if (location.href !== this.#href) {
        this.#href = location.href;
        this.#draft = null;
        this.#scope = { query: false, hash: false };
        void this.#load();
      }
    }, 1000);
    setInterval(() => {
      if (document.visibilityState === "visible" && !this.#draft && !this.#editing) void this.#load();
    }, REFRESH_EVERY_MS);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.#draft && !this.#editing) void this.#load();
    });

    // The page's DOM changes: find the annotated elements again, but not on every mutation.
    if (document.body) new MutationObserver(() => this.#scheduleReanchor()).observe(document.body, { childList: true, subtree: true });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.#draft) this.#cancelDraft();
    });
  }

  /* ------------------------------------------------------------------ data */

  async #load(): Promise<void> {
    try {
      this.#setPages(await call<LivePage[]>({ type: "live.list", url: location.href }));
      this.#error = "";
    } catch (e) {
      this.#error = (e as Error).message;
    }
    this.#syncOverlay();
    this.#render();
  }

  async #mutate(action: () => Promise<unknown>): Promise<void> {
    this.#busy = true;
    this.#render();
    try {
      await action();
      this.#error = "";
    } catch (e) {
      this.#error = (e as Error).message;
    }
    this.#busy = false;
    await this.#load();
  }

  #setPages(pages: LivePage[]): void {
    this.#annotations = pages
      .flatMap((page) => page.annotations.map((a) => ({ ...a, projectId: page.projectId })))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  #canCommentIn(projectId: string): boolean {
    return this.#projects.get(projectId)?.canComment ?? false;
  }

  #labelOf(id: string): number {
    return this.#annotations.findIndex((a) => a.id === id) + 1;
  }

  #visible(): PageAnnotation[] {
    return this.#annotations.filter((a) => this.#showResolved || a.status === "Open");
  }

  #syncOverlay(): void {
    const annotations: OverlayAnnotation[] = this.#visible().map((a) => ({
      id: a.id, kind: a.kind as AnnotationKind, color: a.color, resolved: a.status === "Resolved", label: this.#labelOf(a.id),
      anchor: a.anchor as Anchor, geometry: a.geometry as Geometry,
    }));
    this.#overlay.handle({ type: "setAnnotations", annotations });
    this.#overlay.handle({ type: "select", id: this.#selected, scroll: false });
  }

  #scheduleReanchor(): void {
    const now = Date.now();
    if (!this.#reanchorTimer) this.#reanchorSince = now;
    clearTimeout(this.#reanchorTimer);
    const wait = now - this.#reanchorSince > REANCHOR_MAX_WAIT_MS ? 0 : REANCHOR_DELAY_MS;
    this.#reanchorTimer = window.setTimeout(() => {
      this.#reanchorTimer = 0;
      if (this.#annotations.length > 0) this.#overlay.reanchor();
    }, wait);
  }

  /* ------------------------------------------------------------------ overlay events */

  #onOverlay(message: OverlayMessage): void {
    switch (message.type) {
      case "draft":
        this.#draft = message.draft;
        this.#draftInput = null;
        this.#open = true;
        this.#render(); // creates the comment box
        (this.#draftInput as HTMLTextAreaElement | null)?.focus();
        break;
      case "selected":
        this.#selected = message.id;
        this.#open = true;
        this.#render();
        this.#root.querySelector(`[data-id="${CSS.escape(message.id ?? "")}"]`)?.scrollIntoView({ block: "nearest" });
        break;
      case "anchors":
        this.#quality = message.quality;
        this.#render();
        break;
      case "ready":
        break;
      case "marks": {
        this.#bubbles.setPositions(message.positions);
        const ids = Object.keys(message.positions).sort().join();
        if (ids !== this.#markIds) {
          this.#markIds = ids;
          this.#renderBubbles();
        }
        break;
      }
      case "hover":
        if (message.id) {
          clearTimeout(this.#hideTimer);
          if (this.#tool === "select" && message.id !== this.#hoverId) {
            this.#hoverId = message.id;
            this.#renderBubbles();
          }
        } else {
          this.#scheduleHide();
        }
        break;
    }
  }

  #setTool(tool: Tool): void {
    this.#tool = tool;
    this.#overlay.handle({ type: "setTool", tool, color: this.#color });
    this.#render();
  }

  /** The scope to save with, limited to the parts this address actually has. */
  #chosenScope(): { includeQuery: boolean; includeHash: boolean } {
    return { includeQuery: this.#scope.query && location.search.length > 1, includeHash: this.#scope.hash && location.hash.length > 1 };
  }

  /** "Any version of this page" or "Only this address", when the address has a query or #hash. */
  #scopeChooser(): Node {
    const options = scopeOptions();
    if (options.length < 2) return document.createTextNode("");
    const chosen = this.#chosenScope();
    const fieldset = h("fieldset", { className: "scope" }, h("legend", { textContent: "Show this comment on" }));
    for (const option of options) {
      const input = h("input", {
        type: "radio", name: "inklayer-scope",
        checked: option.scope.query === chosen.includeQuery && option.scope.hash === chosen.includeHash,
        onchange: () => { this.#scope = option.scope; this.#render(); },
      });
      fieldset.append(h("label", { title: option.address }, input,
        h("span", { className: "scope-text" }, h("span", { textContent: option.label }), h("span", { className: "address", textContent: option.address }))));
    }
    return fieldset;
  }

  #cancelDraft(): void {
    this.#draft = null;
    this.#draftInput = null;
    this.#overlay.handle({ type: "clearDraft" });
    this.#render();
  }

  async #saveDraft(): Promise<void> {
    const draft = this.#draft;
    const body = this.#draftInput ? encodeMentions(this.#draftInput.value.trim(), pickedIn(this.#draftInput)) : "";
    const target = this.#target;
    if (!draft || !target || this.#busy) return;
    await this.#mutate(async () => {
      const created = await call<LiveAnnotation>({
        type: "live.create", projectId: target.id, url: location.href,
        ...this.#chosenScope(),
        kind: draft.kind, body, color: this.#color, anchor: draft.anchor, geometry: draft.geometry, viewportWidth: draft.viewportWidth,
      });
      if (this.#init.features.bugContext && this.#attachContext) await this.#attachPageDetails(created.id, draft);
      this.#draft = null;
      this.#draftInput = null;
      this.#selected = created.id;
      this.#overlay.handle({ type: "clearDraft" });
      this.#setTool("select");
    });
  }

  /* ------------------------------------------------------------------ bug context */

  /**
   * Adds a screenshot of the commented area and the page details to a new comment. Best effort: the comment is saved
   * whatever happens here.
   */
  async #attachPageDetails(annotationId: string, draft: Draft): Promise<void> {
    const element = resolveElement(document, draft.anchor.element).element;
    const range = element && draft.anchor.text ? resolveRange(element, draft.anchor.text).range : null;
    const box = range?.getBoundingClientRect() ?? element?.getBoundingClientRect() ?? null;
    const target: Rect = box ? { x: box.left, y: box.top, width: box.width, height: box.height } : { x: innerWidth / 2, y: innerHeight / 2, width: 0, height: 0 };

    const context: PageContext = {
      browser: browserOf(navigator.userAgent),
      os: osOf(navigator.userAgent),
      userAgent: navigator.userAgent,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      devicePixelRatio: devicePixelRatio,
      selector: draft.anchor.element.path.join(" >>> "),
      elementHtml: element ? elementHtml(element) : "",
      ...(await pageLogs()),
    };
    await call({ type: "live.context", annotationId, context }).catch(() => undefined);

    // The screenshot shows the page and the marks, not the panel or bubbles.
    const hidden = [this.#host, this.#bubbles.host];
    for (const el of hidden) el.style.visibility = "hidden";
    try {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await call({ type: "live.capture", annotationId, area: screenshotArea(target, { width: innerWidth, height: innerHeight }), viewportWidth: innerWidth });
    } catch (e) {
      // The comment and its details are saved; say why there's no screenshot.
      for (const el of hidden) el.style.visibility = "";
      this.#flashNote(`No screenshot: ${(e as Error).message}`);
      return;
    } finally {
      for (const el of hidden) el.style.visibility = "";
    }
    // Uploaded in the background; once it's there, show it.
    try {
      await call({ type: "live.captureResult", annotationId });
      await this.#load();
    } catch (e) {
      this.#flashNote(`The screenshot didn't upload: ${(e as Error).message}`);
    }
  }

  /** The screenshot, drawn on a canvas (images from the extension can't be blocked by the page's content policy). Click to enlarge. */
  #screenshotOf(a: PageAnnotation): Node {
    if (!this.#init.features.bugContext || !a.hasScreenshot) return document.createTextNode("");
    const canvas = h("canvas", { className: "shot", title: "Screenshot when this was commented: click to enlarge" });
    void loadScreenshot(a.id).then((bitmap) => {
      if (!bitmap) return canvas.remove();
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    });
    canvas.addEventListener("click", (e) => {
      e.stopPropagation();
      void loadScreenshot(a.id).then((bitmap) => bitmap && this.#enlarge(bitmap));
    });
    return canvas;
  }

  #enlarge(bitmap: ImageBitmap): void {
    const canvas = h("canvas", { className: "shot-large" });
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const box = h("div", { className: "lightbox", title: "Click to close", onclick: () => box.remove() }, canvas);
    this.#shadow.append(box);
  }

  /** Issues made from the comment, and "Create issue" when the project has trackers connected. */
  #issuesOf(a: PageAnnotation): Node {
    if (!this.#init.features.issueTrackers) return document.createTextNode("");
    const names = { github: "GitHub", jira: "Jira", linear: "Linear" } as const;
    const row = h("div", { className: "issues", onclick: (e: Event) => e.stopPropagation() });
    for (const issue of a.issues ?? []) {
      if (!/^https:\/\//.test(issue.url)) continue;
      row.append(h("a", { className: `issue ${issue.state}`, href: issue.url, target: "_blank", rel: "noopener noreferrer",
        title: `${names[issue.kind]} ${issue.key} (${issue.state})`, textContent: `${issue.state === "open" ? "●" : "✓"} ${names[issue.kind]} ${issue.key}` }));
    }
    const trackers = this.#canCommentIn(a.projectId) ? this.#trackersIn(a.projectId) : [];
    if (trackers.length === 1) {
      const t = trackers[0]!;
      row.append(h("button", { className: "link", textContent: "Create issue", title: `Create an issue in ${names[t.kind]}: ${t.name}`, disabled: this.#busy,
        onclick: () => void this.#mutate(() => call({ type: "live.issue", annotationId: a.id, connectionId: t.id })) }));
    } else if (trackers.length > 1) {
      const pick = h("select", { className: "issue-pick", title: "Create an issue from this comment", disabled: this.#busy },
        h("option", { value: "", textContent: "Create issue in…" }), ...trackers.map((t) => h("option", { value: t.id, textContent: `${names[t.kind]}: ${t.name}` })));
      pick.addEventListener("change", () => {
        if (pick.value) void this.#mutate(() => call({ type: "live.issue", annotationId: a.id, connectionId: pick.value }));
      });
      row.append(pick);
    }
    return row.childElementCount ? row : document.createTextNode("");
  }

  #trackersIn(projectId: string): TrackerChoice[] {
    const known = this.#trackers.get(projectId);
    if (known === undefined) {
      this.#trackers.set(projectId, "loading");
      void call<TrackerChoice[]>({ type: "live.trackers", projectId })
        .then((choices) => { this.#trackers.set(projectId, choices); if (choices.length) this.#render(); })
        .catch(() => this.#trackers.set(projectId, []));
    }
    return Array.isArray(known) ? known : [];
  }

  /** "Made at 390px wide · you're at 1440px", with a button to see the page at their size. */
  #sizeOf(a: PageAnnotation): Node {
    const width = a.viewportWidth ?? 0;
    const height = a.context?.viewportHeight ?? null;
    if (!sizeDiffers(width, innerWidth)) return document.createTextNode("");
    return h("div", { className: "row size", onclick: (e: Event) => e.stopPropagation() },
      h("span", { className: "muted", textContent: `Made at ${width}px wide · you're at ${innerWidth}px`,
        title: "Pages often lay out differently at other widths, so the comment may be about a layout you aren't seeing." }),
      h("button", { className: "link", textContent: "Match their size", disabled: this.#busy, title: height ? `Resize this window so the page is ${width}×${height}` : `Resize this window so the page is ${width}px wide`,
        onclick: () => void this.#matchSize(a.id, width, height, a.context?.zoom ?? null) }));
  }

  /**
   * Resizes the window so the page is <paramref name="width"/> (× <paramref name="height"/>) CSS pixels, centred on the
   * screen. Window sizes are in screen units and the page in CSS pixels (page zoom, display scaling), so it measures the
   * result and corrects, a few times at most.
   */
  async #matchSize(id: string, width: number, height: number | null, zoom: number | null): Promise<void> {
    const target = { width, height };
    const settled = () => new Promise<void>((resolve) => {
      window.addEventListener("resize", () => window.setTimeout(resolve, 150), { once: true });
      window.setTimeout(resolve, 700);
    });
    const screenBox = screen as Screen & { availLeft?: number; availTop?: number };
    const centred = (w: number, h: number) => ({
      left: Math.round((screenBox.availLeft ?? 0) + Math.max(0, (screen.availWidth - w) / 2)),
      top: Math.round((screenBox.availTop ?? 0) + Math.max(0, (screen.availHeight - h) / 2)),
    });
    const resize = async (size: { width: number; height?: number }) => {
      const resized = new Promise<void>((resolve) => {
        const done = () => window.setTimeout(resolve, 150); // let the page lay out again
        window.addEventListener("resize", done, { once: true });
        window.setTimeout(resolve, 900);
      });
      const result = await call<{ width: number; height: number }>({ type: "live.matchSize", ...size, ...centred(size.width, size.height ?? outerHeight) });
      await resized;
      return result;
    };

    try {
      // Their zoom first (zoom changes the page's width in CSS pixels), then the window.
      if (zoom) {
        const done = settled();
        await call({ type: "live.setZoom", zoom });
        await done;
      }
      // First guess: the target plus the browser's frame.
      let guess = windowSizeFor(target, { innerWidth, innerHeight, outerWidth, outerHeight });
      let before = { window: { width: outerWidth, height: outerHeight }, page: { width: innerWidth, height: innerHeight } };
      for (let pass = 0; pass < 3; pass++) {
        const got = await resize(guess);
        const page = { width: innerWidth, height: innerHeight };
        const offW = width - page.width;
        const offH = height ? height - page.height : 0;
        if (Math.abs(offW) <= 2 && Math.abs(offH) <= 2) break;
        // Screen units per CSS pixel, from how much the page changed when the window did (1 if it didn't change).
        const per = (a: number, b: number) => (b !== 0 && a !== 0 ? Math.abs(a / b) : 1);
        const perW = per(got.width - before.window.width, page.width - before.page.width);
        const perH = per(got.height - before.window.height, page.height - before.page.height);
        if (page.width === before.page.width && page.height === before.page.height && pass > 0) break; // the browser won't go further
        before = { window: got, page };
        guess = { width: Math.round(got.width + offW * perW), ...(height ? { height: Math.round(got.height + offH * perH) } : {}) };
      }

      // The window can't get there (minimum width, or the screen isn't wide enough): zoom so the page lays out at their
      // width anyway. Text looks bigger or smaller than they saw it, but the layout is theirs.
      let note = "";
      if (Math.abs(innerWidth - width) > 2) {
        const current = await call<number>({ type: "live.getZoom" });
        const done = settled();
        const set = await call<number>({ type: "live.setZoom", zoom: current * innerWidth / width });
        await done;
        const pct = (z: number) => `${Math.round(z * 100)}%`;
        note = Math.abs(innerWidth - width) <= 2
          ? `Your window can't be ${width}px wide, so the page is zoomed to ${pct(set)} to lay out at their width${zoom ? ` (they were at ${pct(zoom)})` : ""}.`
          : `This is as close as your browser gets: ${innerWidth}px wide at ${pct(set)} zoom. For phone sizes, DevTools' device mode (Ctrl+Shift+M) goes further.`;
      }

      this.#sizeMatched = target;
      if (note) this.#flashNote(note);
      else this.#render();
      window.setTimeout(() => this.#overlay.handle({ type: "select", id, scroll: true }), REANCHOR_MAX_WAIT_MS);
    } catch (e) {
      this.#flashNote(`Couldn't resize the window: ${(e as Error).message}`);
    }
  }

  async #restoreSize(): Promise<void> {
    try {
      await call({ type: "live.restoreSize" });
    } catch (e) {
      this.#flashNote(`Couldn't restore the window: ${(e as Error).message}`);
    }
    this.#sizeMatched = null;
    this.#render();
  }

  /** Browser, window size, the element, console errors and failed requests, folded away. */
  #detailsOf(a: PageAnnotation): Node {
    const c = a.context;
    if (!this.#init.features.bugContext || !c) return document.createTextNode("");
    const errors = c.console.filter((e) => e.level === "error").length;
    const summary = [`${c.browser} · ${c.os} · ${c.viewportWidth}×${c.viewportHeight}${c.zoom && Math.abs(c.zoom - 1) > 0.01 ? ` at ${Math.round(c.zoom * 100)}%` : ""}`, errors ? `${errors} console error${errors === 1 ? "" : "s"}` : "",
      c.network.length ? `${c.network.length} failed request${c.network.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    const details = h("details", { className: "context", onclick: (e: Event) => e.stopPropagation() }, h("summary", { textContent: summary }));
    if (c.selector) details.append(h("p", { className: "muted", textContent: `Element: ${c.selector}` }));
    if (c.console.length) {
      details.append(h("ul", {}, ...c.console.map((e) => h("li", { className: e.level === "error" ? "error" : "", textContent: `${e.level}: ${e.message}` }))));
    }
    if (c.network.length) {
      details.append(h("ul", {}, ...c.network.map((n) => h("li", { textContent: `${n.method} ${n.url} → ${n.status || "failed"}${n.ms ? ` (${n.ms} ms)` : ""}` }))));
    }
    return details;
  }

  /* ------------------------------------------------------------------ activity */

  #setView(view: View): void {
    this.#view = view;
    if (view === "inbox") void this.#loadInbox();
    if (view === "activity" && !this.#activity) {
      this.#activity = { items: [], kinds: ["comments"], nextBefore: null, thisSite: true, kind: null, loading: false, error: "" };
      void this.#loadActivity(false);
    }
    this.#render();
  }

  /** Loads the first page of the activity log, or the next (older) page when <code>more</code> is true. */
  async #loadActivity(more: boolean): Promise<void> {
    const state = this.#activity;
    if (!state || state.loading) return;
    state.loading = true;
    state.error = "";
    this.#render();
    try {
      const page = await call<ActivityPage>({
        type: "live.activity", thisSite: state.thisSite, ...(state.kind ? { kind: state.kind } : {}), ...(more && state.nextBefore ? { before: state.nextBefore } : {}),
      });
      state.items = more ? [...state.items, ...page.items] : page.items;
      state.kinds = page.kinds;
      state.nextBefore = page.nextBefore;
    } catch (e) {
      state.error = (e as Error).message;
    }
    state.loading = false;
    this.#render();
  }

  #activityParts(): Node[] {
    const state = this.#activity!;
    const scope = h("select", { title: "Which activity to show", onchange: () => {
      state.thisSite = scope.value === "site";
      if (state.thisSite) state.kind = null; // site activity is comments only
      void this.#loadActivity(false);
    } },
    h("option", { value: "site", textContent: `This site (${location.host})`, selected: state.thisSite }),
    h("option", { value: "all", textContent: "Everywhere", selected: !state.thisSite }));
    const filters = h("div", { className: "row filters" }, scope);
    if (!state.thisSite && state.kinds.length > 1) {
      const kind = h("select", { title: "Type of activity", onchange: () => {
        state.kind = (kind.value || null) as ActivityItem["kind"] | null;
        void this.#loadActivity(false);
      } }, h("option", { value: "", textContent: "All types", selected: !state.kind }));
      for (const k of state.kinds) kind.append(h("option", { value: k, textContent: KIND_LABELS[k], selected: state.kind === k }));
      filters.append(kind);
    }

    const parts: Node[] = [filters];
    if (state.error) parts.push(h("p", { className: "error", textContent: state.error }));
    const list = h("ol", { className: "list activity" });
    for (const item of state.items) list.append(this.#activityItem(item));
    if (state.items.length === 0 && !state.loading) list.append(h("li", { className: "empty", textContent: state.thisSite ? "No activity on this site yet." : "No activity yet." }));
    parts.push(list);
    if (state.loading) parts.push(h("p", { className: "hint", textContent: "Loading…" }));
    else if (state.nextBefore) parts.push(h("button", { className: "link", textContent: "Show older", onclick: () => void this.#loadActivity(true) }));
    return parts;
  }

  #docUrl(organizationId: string, docId: string): string {
    return `${this.#init.serverUrl}/orgs/${encodeURIComponent(organizationId)}/docs/${encodeURIComponent(docId)}`;
  }

  /** The comment's text, with [[doc]] links that open the doc. Built with text nodes only. */
  #bodyOf(a: PageAnnotation): HTMLParagraphElement {
    return this.#linkedText(a.body, a);
  }

  /** Text from a comment or one of its replies, with its [[doc]] links. */
  #linkedText(text: string, a: PageAnnotation): HTMLParagraphElement {
    const p = h("p", { className: "body" });
    for (const part of commentParts(text, a.docLinks ?? [], a.people ?? [])) {
      if ("text" in part) p.append(part.text);
      else if ("mention" in part) p.append(h("span", { className: "mention", textContent: `@${part.mention}`, title: part.fullName ?? part.mention }));
      // With docs turned off, [[links]] are just text.
      else if (!this.#init.features.docs) p.append(`[[${part.shown}]]`);
      else if (part.docId) {
        p.append(h("a", { className: "doclink", href: this.#docUrl(a.organizationId, part.docId), target: "_blank", rel: "noopener", textContent: part.shown,
          title: `Open the doc "${part.link}"`, onclick: (e: Event) => e.stopPropagation() }));
      } else {
        p.append(h("span", { className: "doclink missing", textContent: part.shown, title: `There's no doc called "${part.link}" yet` }));
      }
    }
    return p;
  }

  #activityItem(item: ActivityItem): HTMLLIElement {
    const who = item.actor?.displayName || item.actor?.email || "";
    const verb = (item.kind === "docs" ? DOC_VERBS[item.action] : ACTIVITY_VERBS[item.action]) ?? item.action;
    const line = h("div", { className: "meta" },
      who ? h("strong", { textContent: who, title: item.actor ? personTitle(item.actor) : "" }) : "", h("span", { className: item.kind === "errors" ? "error" : "", textContent: who ? ` ${verb}` : verb }),
      h("span", { className: "muted grow-left", textContent: timeAgo(item.occurredAt), title: new Date(item.occurredAt).toLocaleString() }));
    const li = h("li", { className: `item activity-${item.kind}` }, line);
    if (item.detail) li.append(h("p", { className: item.kind === "errors" ? "body error-detail" : "body", textContent: item.detail }));
    if (item.kind === "docs" && item.docId && item.organizationId && item.action !== "deleted") {
      li.append(h("div", { className: "muted where" },
        h("a", { href: this.#docUrl(item.organizationId, item.docId), target: "_blank", rel: "noopener", textContent: "Open doc", onclick: (e: Event) => e.stopPropagation() })));
    }
    if (item.pageUrl && /^https?:\/\//.test(item.pageUrl)) {
      const url = new URL(item.pageUrl);
      li.append(h("div", { className: "muted where" },
        h("a", { href: item.pageUrl, target: "_blank", rel: "noopener noreferrer", textContent: url.host + url.pathname, title: item.pageUrl, onclick: (e: Event) => e.stopPropagation() }),
        item.projectName ? ` · ${item.projectName}` : ""));
    }
    // A comment on this page: clicking it shows the comment.
    if (item.annotationId && this.#annotations.some((a) => a.id === item.annotationId)) {
      li.classList.add("here");
      li.title = "Show this comment on the page";
      li.onclick = () => this.#showOnPage(item.annotationId!);
    }
    return li;
  }

  /** Selects a comment on this page and switches to the comments list. */
  #showOnPage(id: string): void {
    // Resolved comments are hidden by default; show them if that's the one being opened.
    if (this.#annotations.find((a) => a.id === id)?.status === "Resolved" && !this.#showResolved) {
      this.#showResolved = true;
      this.#syncOverlay();
    }
    this.#selected = id;
    this.#overlay.handle({ type: "select", id, scroll: true });
    this.#setView("comments");
  }

  /* ------------------------------------------------------------------ inbox */

  async #loadInbox(): Promise<void> {
    this.#inbox = { data: this.#inbox?.data ?? null, loading: true, error: "" };
    this.#render();
    try {
      this.#inbox = { data: await call<Inbox>({ type: "live.inbox" }), loading: false, error: "" };
    } catch (e) {
      this.#inbox = { data: this.#inbox.data, loading: false, error: (e as Error).message };
    }
    this.#render();
  }

  /** Mentions, replies and resolved comments for you, newest first. A comment on this page opens here; anything else in a new tab. */
  #inboxParts(): Node[] {
    const state = this.#inbox;
    const box = state?.data;
    const parts: Node[] = [];
    const head = h("div", { className: "row inbox-head" }, h("strong", { textContent: this.#unread ? `${this.#unread} unread` : "All read" }));
    if (this.#unread > 0) {
      head.append(h("button", { className: "link", textContent: "Mark all read", disabled: this.#busy,
        onclick: () => void call({ type: "live.inboxRead" }).then(() => this.#loadInbox()).catch((e: unknown) => { this.#error = (e as Error).message; this.#render(); }) }));
    }
    parts.push(head);
    if (state?.error) parts.push(h("p", { className: "error", textContent: state.error }));
    const list = h("ol", { className: "list inbox" });
    for (const item of box?.items ?? []) list.append(this.#inboxItem(item, box!.serverUrl));
    if (box && box.items.length === 0) list.append(h("li", { className: "empty", textContent: "Nothing yet. You'll hear here when someone mentions you, replies in your threads or resolves your comments." }));
    parts.push(list);
    if (state?.loading && !box) parts.push(h("p", { className: "hint", textContent: "Loading…" }));
    return parts;
  }

  #inboxItem(item: InboxItem, serverUrl: string): HTMLLIElement {
    const verb = INBOX_TEXT[item.kind] ?? item.kind;
    const who = item.kind === "issue_closed" ? null : item.actor?.displayName ?? "Someone";
    const here = item.annotationId !== null && this.#annotations.some((a) => a.id === item.annotationId);
    const li = h("li", { className: item.read ? "item read" : "item unread", title: here ? "Show this comment on the page" : "Open in Inklayer" },
      h("div", { className: "meta" },
        item.read ? "" : h("span", { className: "unread-dot", ariaLabel: "unread" }),
        who ? h("strong", { textContent: who, title: item.actor?.fullName ?? "" }) : "",
        h("span", { textContent: who ? ` ${verb}` : verb }),
        h("span", { className: "muted grow-left", textContent: timeAgo(item.createdAt), title: new Date(item.createdAt).toLocaleString() })),
      h("p", { className: "body clamp", textContent: item.preview }));
    if (item.where) li.append(h("div", { className: "muted where", textContent: here ? "On this page" : item.where }));
    li.onclick = () => {
      if (!item.read) void call({ type: "live.inboxRead", ids: [item.id] }).catch(() => undefined);
      if (here) return this.#showOnPage(item.annotationId!);
      const url = item.annotationId ? `${serverUrl}/comments/${item.annotationId}`
        : item.docId ? `${serverUrl}/orgs/${item.organizationId}/docs/${item.docId}` : serverUrl;
      window.open(url, "_blank", "noopener");
    };
    return li;
  }

  /* ------------------------------------------------------------------ panel */

  /** Redraws the panel, keeping focus and the cursor in a comment box the user is typing in. */
  #render(): void {
    const focused = this.#shadow.activeElement;
    const typing = focused instanceof HTMLTextAreaElement ? { el: focused, start: focused.selectionStart, end: focused.selectionEnd } : null;
    this.#draw();
    if (typing?.el.isConnected) {
      typing.el.focus();
      typing.el.setSelectionRange(typing.start, typing.end);
    }
    this.#renderBubbles();
  }

  /* ------------------------------------------------------------------ bubbles */

  /** Hides the hover bubble shortly after the pointer leaves, unless it moved into the bubble or a reply is being written there. */
  #scheduleHide(): void {
    clearTimeout(this.#hideTimer);
    this.#hideTimer = window.setTimeout(() => {
      const id = this.#hoverId;
      if (!id || this.#inBubble) return;
      if (this.#bubbles.hasFocus(id) || this.#replyInputs.get(`bubble:${id}`)?.value.trim()) return;
      this.#hoverId = null;
      this.#renderBubbles();
    }, 350);
  }

  #renderBubbles(): void {
    if (!this.#marksVisible) {
      this.#bubbles.show([], () => []);
      return;
    }
    const visible = this.#visible();
    const ids = visible.filter((a) => this.#bubblesOpen || this.#pinned.has(a.id) || a.id === this.#hoverId).map((a) => a.id);
    this.#bubbles.show(ids, (id) => this.#bubbleContent(visible.find((a) => a.id === id)!));
  }

  #bubbleContent(a: PageAnnotation): Node[] {
    const pinned = this.#pinned.has(a.id);
    const pin = h("button", {
      className: pinned ? "pin-toggle on" : "pin-toggle",
      title: pinned ? "Unpin: show only on hover" : "Pin: keep this open",
      onclick: () => {
        if (pinned) this.#pinned.delete(a.id);
        else this.#pinned.add(a.id);
        this.#renderBubbles();
      },
    });
    pin.append(pinIcon());
    const dot = h("span", { className: "dot" });
    dot.style.background = a.color;
    const nodes: Node[] = [
      h("div", { className: "bubble-head" }, dot, h("strong", { textContent: a.author.displayName || "Someone", title: personTitle(a.author) }),
        h("span", { className: "muted", textContent: timeAgo(a.createdAt) }),
        a.status === "Resolved" ? h("span", { className: "muted", textContent: "· resolved" }) : "",
        h("span", { className: "grow" }), pin),
    ];
    if (a.body) nodes.push(this.#bodyOf(a));
    nodes.push(this.#sizeOf(a), this.#screenshotOf(a), this.#detailsOf(a), this.#issuesOf(a));
    if (a.replies?.length) nodes.push(this.#repliesOf(a));
    if (this.#canCommentIn(a.projectId)) {
      nodes.push(this.#replyBox(a, "bubble"));
      const resolved = a.status === "Resolved";
      nodes.push(h("div", { className: "row" },
        h("button", { className: "link", textContent: resolved ? "Reopen" : "Resolve", disabled: this.#busy,
          onclick: () => void this.#mutate(() => call({ type: "live.update", id: a.id, version: a.version, status: resolved ? "Open" : "Resolved" })) }),
        h("button", { className: "link", textContent: "Show in list", onclick: () => this.focusComment(a.id) })));
    }
    return nodes;
  }

  #repliesOf(a: PageAnnotation): HTMLUListElement {
    const list = h("ul", { className: "replies" });
    for (const r of a.replies ?? []) {
      const meta = h("div", { className: "meta" }, h("strong", { textContent: r.author.displayName || "Someone", title: personTitle(r.author) }), h("span", { className: "muted", textContent: ` ${timeAgo(r.createdAt)}` }));
      if (r.canDelete) {
        meta.append(" ", h("button", { className: "link danger", textContent: "Delete", disabled: this.#busy, onclick: (e: Event) => {
          e.stopPropagation();
          if (window.confirm("Delete this reply?")) void this.#mutate(() => call({ type: "live.replyDelete", id: r.id, version: r.version }));
        } }));
      }
      list.append(h("li", { className: "reply" }, meta, this.#linkedText(r.body, a)));
    }
    return list;
  }

  /** A box to reply in a comment's thread. Enter sends; Shift+Enter starts a new line; [[ suggests docs. */
  #replyBox(a: PageAnnotation, place: "bubble" | "panel"): HTMLElement {
    const key = `${place}:${a.id}`;
    let input = this.#replyInputs.get(key);
    if (!input) {
      const box = h("textarea", { className: "reply-box", placeholder: "Reply… (Enter to send)", rows: 1, onclick: (e: Event) => e.stopPropagation() });
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        const body = encodeMentions(box.value.trim(), pickedIn(box));
        if (!body) return;
        box.value = "";
        void this.#mutate(() => call({ type: "live.reply", annotationId: a.id, body }).catch((error: unknown) => {
          box.value = body; // keep what they wrote
          throw error;
        }));
      });
      this.#replyInputs.set(key, box);
      input = box;
    }
    return withSuggestions(input, () => this.#projects.get(a.projectId)?.organizationId ?? null, this.#init.features.docs);
  }

  async #sharePage(): Promise<void> {
    const target = this.#target;
    if (!target) return;
    try {
      const share = await call<{ url: string; existing: boolean; expiresAt: string | null }>({ type: "live.share", projectId: target.id, url: location.href });
      this.#shared = { url: share.url, existing: share.existing, expiresAt: share.expiresAt, projectName: target.name, copied: await copyText(share.url) };
      this.#render();
    } catch (e) {
      this.#flashNote(`Couldn't share: ${(e as Error).message}`);
    }
  }

  /** The share link, with what it shows and until when; stays until closed. */
  #sharedBox(): HTMLElement {
    const shared = this.#shared!;
    const until = shared.expiresAt ? `until ${new Date(shared.expiresAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : "with no end date";
    const copy = h("button", { className: "link", textContent: shared.copied ? "Copied" : "Copy", onclick: () => void copyText(shared.url).then((ok) => {
      copy.textContent = ok ? "Copied" : "Couldn't copy";
      window.setTimeout(() => (copy.textContent = "Copy"), 1500);
    }) });
    return h("div", { className: "shared" },
      h("div", { className: "row" },
        h("strong", { textContent: shared.existing ? "This page's share link" : "Share link created" }),
        h("button", { className: "icon close", title: "Close", textContent: "×", onclick: () => { this.#shared = null; this.#render(); } })),
      h("div", { className: "row link-row" },
        h("a", { className: "share-url", href: shared.url, target: "_blank", rel: "noopener noreferrer", textContent: shared.url, title: shared.url }), copy),
      h("p", { className: "hint", textContent: `${shared.existing ? "It already existed, so it's the same link as before. " : ""}${shared.copied ? "Copied. " : ""}`
        + `Anyone with it can read this page's open comments in ${shared.projectName}, ${until}. Turn it off from the project's Sharing tab.` }));
  }

  #setBubblesOpen(open: boolean): void {
    this.#bubblesOpen = open;
    void chrome.storage.local.set({ bubblesOpen: open }).catch(() => undefined);
    this.#render();
  }

  #draw(): void {
    if (!this.#open) {
      const open = this.#annotations.filter((a) => a.status === "Open").length;
      const launcher = h("button", { className: this.#panelPinned ? "launcher" : "launcher movable",
        title: this.#panelPinned ? "Inklayer comments on this page" : "Inklayer comments on this page (drag to move)", onclick: () => {
        if (this.#dragged) return;
        this.#open = true;
        this.#render();
      } }, "Inklayer", h("span", { className: open ? "count" : "count zero", textContent: String(open), title: `${open} open comment${open === 1 ? "" : "s"} on this page` }),
      this.#unread > 0 ? h("span", { className: "bell-count", title: `${this.#unread} unread notification${this.#unread === 1 ? "" : "s"}` }, bellIcon(), String(Math.min(this.#unread, 99))) : "");
      launcher.addEventListener("pointerdown", (e) => this.#startDrag(e));
      this.#root.replaceChildren(launcher);
      this.#placePanel();
      return;
    }

    const tab = (view: View, label: string) =>
      h("button", { className: this.#view === view ? "tab active" : "tab", textContent: label, onclick: () => this.#setView(view) });
    const actions = h("div", { className: "actions" },
      this.#init.features.sharing && this.#target ? h("button", { className: "icon svg", disabled: this.#busy,
        title: `Share this page: copy a read-only link to its open comments in ${this.#target.name}, for people without an account (works for 30 days)`,
        onclick: () => void this.#sharePage() }, linkIcon()) : "",
      h("button", { className: this.#bubblesOpen ? "icon svg on" : "icon svg", ariaPressed: String(this.#bubblesOpen),
        title: this.#bubblesOpen ? "Comments are open next to their marks. Click to show them only on hover." : "Open every comment next to its mark (otherwise they show on hover)",
        onclick: () => this.#setBubblesOpen(!this.#bubblesOpen) }, commentsIcon()),
      h("button", { className: "icon svg", title: this.#marksVisible ? "Hide marks on the page" : "Show marks on the page",
        onclick: () => { this.#marksVisible = !this.#marksVisible; this.#overlay.setVisible(this.#marksVisible); this.#render(); } },
        this.#marksVisible ? eyeIcon() : eyeOffIcon()),
      h("button", { className: this.#view === "inbox" ? "icon svg bell on" : "icon svg bell", ariaPressed: String(this.#view === "inbox"),
        title: this.#unread ? `Notifications: ${this.#unread} unread` : "Notifications",
        onclick: () => this.#setView(this.#view === "inbox" ? "comments" : "inbox") },
        bellIcon(), this.#unread > 0 ? h("span", { className: "badge", textContent: this.#unread > 99 ? "99+" : String(this.#unread) }) : ""),
      h("button", { className: "icon svg", title: "Minimise", onclick: () => { this.#open = false; this.#render(); } }, minimiseIcon()));
    const header = h("div", { className: "header" },
      h("div", { className: "tabs" }, tab("comments", "Comments"), tab("activity", "Activity")), actions);
    header.addEventListener("pointerdown", (e) => this.#startDrag(e));
    // A drag that ends over a tab or icon doesn't also press it.
    header.addEventListener("click", (e) => {
      if (!this.#dragged) return;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    if (!this.#panelPinned) {
      header.classList.add("movable");
      header.prepend(h("span", { className: "grip", title: "Drag to move · double-click to put back in the corner" }, gripIcon()));
      header.addEventListener("dblclick", (e) => {
        if (!(e.target as Element).closest("button, select, input, textarea, a, label")) this.#resetPosition();
      });
    }

    const parts: Node[] = [header];
    if (this.#sizeMatched) {
      const m = this.#sizeMatched;
      parts.push(h("div", { className: "row size-bar" },
        h("span", { textContent: m === "unknown" ? "This window was resized to a commenter's size." : `Showing the page at their size: ${m.width}${m.height ? `×${m.height}` : "px wide"}.` }),
        h("button", { className: "link", textContent: "Back to my size", onclick: () => void this.#restoreSize() })));
    }
    if (this.#shared) parts.push(this.#sharedBox());
    if (this.#shareNote) parts.push(h("p", { className: "hint", textContent: this.#shareNote }));
    if (this.#view === "inbox") {
      this.#root.replaceChildren(h("div", { className: "panel" }, ...parts, ...this.#inboxParts()), this.#cornerPin());
      this.#placePanel();
      return;
    }
    if (this.#view === "activity") {
      this.#root.replaceChildren(h("div", { className: "panel" }, ...parts, ...this.#activityParts()), this.#cornerPin());
      this.#placePanel();
      return;
    }

    if (this.#target) {
      const commentable = this.#init.projects.filter((p) => p.canComment);
      if (commentable.length > 1) {
        const select = h("select", { onchange: () => {
          this.#target = this.#projects.get(select.value) ?? this.#target;
          this.#render();
        } });
        for (const p of commentable) select.append(h("option", { value: p.id, textContent: `${p.organizationName} / ${p.name}`, selected: p.id === this.#target!.id }));
        parts.push(h("label", { className: "target" }, "New comments go to", select));
      } else {
        parts.push(h("p", { className: "hint", textContent: `New comments go to ${this.#target.name}.` }));
      }
      const tools = h("div", { className: "tools" });
      for (const t of TOOLS) {
        tools.append(h("button", { className: t.tool === this.#tool ? "tool active" : "tool", textContent: t.label, title: t.title, onclick: () => this.#setTool(t.tool) }));
      }
      const colors = h("div", { className: "colors" });
      for (const c of COLORS) {
        const swatch = h("button", { className: c === this.#color ? "swatch active" : "swatch", title: c, onclick: () => { this.#color = c; this.#setTool(this.#tool); } });
        swatch.style.background = c;
        colors.append(swatch);
      }
      parts.push(tools, colors);
      if (this.#tool !== "select" && !this.#draft) {
        parts.push(h("p", { className: "hint", textContent: this.#tool === "highlight" ? "Select some text on the page." : this.#tool === "pin" || this.#tool === "element" ? "Click something on the page." : "Drag on the page." }));
      }
    } else {
      parts.push(h("p", { className: "hint", textContent: this.#init.projects.length ? "You can view comments here, but not add them (Viewer)." : "You're not in any project yet. Ask an administrator to invite you." }));
    }

    if (this.#draft) {
      this.#draftInput ??= h("textarea", { placeholder: "Add a comment (optional). Ctrl+Enter to save.", rows: 3 });
      this.#draftInput.onkeydown = (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void this.#saveDraft();
        if (e.key === "Escape") this.#cancelDraft();
      };
      parts.push(h("div", { className: "draft" },
        h("strong", { textContent: "New comment" }), withSuggestions(this.#draftInput, () => this.#target?.organizationId ?? null, this.#init.features.docs), this.#scopeChooser(),
        this.#init.features.bugContext ? h("label", { className: "attach", title: "A screenshot of this area, your browser and window size, the element, and the page's recent console errors and failed requests (addresses without query strings)" },
          h("input", { type: "checkbox", checked: this.#attachContext, onchange: (e: Event) => {
            this.#attachContext = (e.target as HTMLInputElement).checked;
            void chrome.storage.local.set({ attachContext: this.#attachContext });
          } }), "Attach screenshot and page details") : "",
        h("div", { className: "row" },
          h("button", { className: "primary", textContent: this.#busy ? "Saving…" : "Save", disabled: this.#busy, onclick: () => void this.#saveDraft() }),
          h("button", { textContent: "Cancel", onclick: () => this.#cancelDraft() }))));
    }

    if (this.#error) parts.push(h("p", { className: "error", textContent: this.#error }));

    const visible = this.#visible();
    const resolvedCount = this.#annotations.length - this.#annotations.filter((a) => a.status === "Open").length;
    const list = h("ol", { className: "list" });
    for (const a of visible) list.append(this.#item(a));
    if (visible.length === 0) list.append(h("li", { className: "empty", textContent: this.#annotations.length ? "No open comments." : "No comments on this page yet." }));
    parts.push(list);
    if (resolvedCount > 0) {
      parts.push(h("button", { className: "link", textContent: this.#showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`,
        onclick: () => { this.#showResolved = !this.#showResolved; this.#syncOverlay(); this.#render(); } }));
    }

    this.#root.replaceChildren(h("div", { className: "panel" }, ...parts), this.#cornerPin());
    this.#placePanel();
  }

  #item(a: PageAnnotation): HTMLLIElement {
    const resolved = a.status === "Resolved";
    const badge = h("span", { className: "badge", textContent: String(this.#labelOf(a.id)) });
    badge.style.background = a.color;
    const meta = h("div", { className: "meta" }, badge, h("strong", { textContent: a.author.displayName || "Someone", title: personTitle(a.author) }), h("span", { className: "muted", textContent: timeAgo(a.createdAt) }));
    if (new Set(this.#annotations.map((x) => x.projectId)).size > 1) meta.append(h("span", { className: "muted", textContent: `· ${this.#projects.get(a.projectId)?.name ?? ""}` }));
    if (this.#quality[a.id] === "orphaned") meta.append(h("span", { className: "warn", textContent: "moved", title: "The element this was attached to has changed; shown where it originally was." }));

    const item = h("li", { className: ["item", resolved ? "resolved" : "", a.id === this.#selected ? "selected" : ""].join(" "), onclick: () => {
      this.#selected = a.id;
      this.#overlay.handle({ type: "select", id: a.id, scroll: true });
      this.#render();
    } });
    item.dataset.id = a.id;
    item.append(meta);
    // On an address with a query or #hash, say whether each comment is for every version of the page or just this one.
    if (location.search.length > 1 || location.hash.length > 1) {
      item.append(h("span", { className: "address", textContent: addressOf(a.pageUrl), title: a.pageUrl ?? "" }));
    }

    if (this.#editing?.id === a.id) {
      const input = this.#editing.input;
      item.append(withSuggestions(input, () => this.#projects.get(a.projectId)?.organizationId ?? null, this.#init.features.docs), h("div", { className: "row" },
        h("button", { className: "primary", textContent: "Save", disabled: this.#busy, onclick: (e: Event) => {
          e.stopPropagation();
          const body = encodeMentions(input.value, pickedIn(input));
          this.#editing = null;
          void this.#mutate(() => call({ type: "live.update", id: a.id, version: a.version, body }));
        } }),
        h("button", { textContent: "Cancel", onclick: (e: Event) => { e.stopPropagation(); this.#editing = null; this.#render(); } })));
      return item;
    }

    if (a.body) item.append(this.#bodyOf(a));
    if (a.id === this.#selected) item.append(this.#sizeOf(a), this.#screenshotOf(a), this.#detailsOf(a), this.#issuesOf(a));
    if (this.#init.features.docs && a.mentionedIn?.length) {
      const mentions = h("p", { className: "muted mentions" }, "Mentioned in ");
      a.mentionedIn.forEach((d, i) => {
        if (i > 0) mentions.append(", ");
        mentions.append(h("a", { href: this.#docUrl(a.organizationId, d.docId), target: "_blank", rel: "noopener", textContent: d.title, onclick: (e: Event) => e.stopPropagation() }));
      });
      item.append(mentions);
    }
    if (a.id === this.#selected) {
      if (a.replies?.length) item.append(this.#repliesOf(a));
      if (this.#canCommentIn(a.projectId)) item.append(this.#replyBox(a, "panel"));
    } else if (a.replies?.length) {
      item.append(h("p", { className: "muted replies-count", textContent: a.replies.length === 1 ? "1 reply" : `${a.replies.length} replies` }));
    }
    const actions = h("div", { className: "row actions" });
    const act = (label: string, run: () => Promise<unknown>) => h("button", { className: "link", textContent: label, disabled: this.#busy, onclick: (e: Event) => { e.stopPropagation(); void this.#mutate(run); } });
    if (this.#canCommentIn(a.projectId)) {
      actions.append(act(resolved ? "Reopen" : "Resolve", () => call({ type: "live.update", id: a.id, version: a.version, status: resolved ? "Open" : "Resolved" })));
    }
    if (a.canEdit) {
      actions.append(h("button", { className: "link", textContent: "Edit", onclick: (e: Event) => {
        e.stopPropagation();
        const box = h("textarea", { rows: 3, onclick: (ev: Event) => ev.stopPropagation() });
        box.value = decodeMentions(a.body, a.people ?? [], pickedIn(box));
        this.#editing = { id: a.id, input: box };
        this.#render();
        this.#editing.input.focus();
      } }));
    }
    // To paste into a doc, which links the comment there.
    actions.append(h("button", { className: "link", textContent: "Copy link", title: "Copy a link to this comment, to paste into a doc", onclick: (e: Event) => {
      e.stopPropagation();
      const button = e.currentTarget as HTMLButtonElement;
      void copyText(`${this.#init.serverUrl}/comments/${a.id}`).then((ok) => {
        button.textContent = ok ? "Copied" : "Couldn't copy";
        window.setTimeout(() => (button.textContent = "Copy link"), 1500);
      });
    } }));
    if (a.canDelete) {
      actions.append(h("button", { className: "link danger", textContent: "Delete", disabled: this.#busy, onclick: (e: Event) => {
        e.stopPropagation();
        if (window.confirm("Delete this comment?")) void this.#mutate(() => call({ type: "live.delete", id: a.id, version: a.version }));
      } }));
    }
    if (actions.childElementCount) item.append(actions);
    return item;
  }
}

/* ------------------------------------------------------------------ theme */

const PANEL_FONT = "Inklayer Outfit";
let panelFontRequested = false;

/** Adds the theme's font to the page under a name of its own, once, when the panel first shows. Without it the panel uses the system font. */
async function loadPanelFont(): Promise<void> {
  if (panelFontRequested) return;
  panelFontRequested = true;
  try {
    const base64 = await call<string>({ type: "live.font" });
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const face = new FontFace(PANEL_FONT, bytes.buffer, { weight: "100 900", display: "swap" });
    document.fonts.add(await face.load());
  } catch {
    // The system font is fine.
  }
}

/** The theme's dark palette applies under :host(.dark); follow the system setting like the viewer and popup do. */
function followColorScheme(host: HTMLElement): void {
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => host.classList.toggle("dark", dark.matches);
  apply();
  dark.addEventListener("change", apply);
}

/* ---------------------------------------------------------------- start-up */

let session: LiveSession | null = null;
let starting: Promise<void> | null = null;

/** Starts the session with comments already loaded, or opens it (on <code>view</code>) if it's running. */
/** Screenshots fetched through the background, decoded once per page. */
const screenshots = new Map<string, Promise<ImageBitmap | null>>();

function loadScreenshot(annotationId: string): Promise<ImageBitmap | null> {
  let entry = screenshots.get(annotationId);
  if (!entry) {
    entry = call<{ type: string; base64: string } | null>({ type: "live.screenshot", annotationId })
      .then((image) => (image ? createImageBitmap(new Blob([Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0))], { type: image.type })) : null))
      .catch(() => null);
    screenshots.set(annotationId, entry);
  }
  return entry;
}

/**
 * The page's recent console errors and failed requests, kept by capture.js in the page's own world. Empty if that
 * script isn't there (e.g. the page loaded before the extension was set up).
 */
function pageLogs(): Promise<Pick<PageContext, "console" | "network">> {
  return new Promise((resolve) => {
    const nonce = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; // randomUUID needs https
    const done = (value: Pick<PageContext, "console" | "network">) => {
      document.removeEventListener("inklayer:context-response", onResponse);
      clearTimeout(timer);
      resolve(value);
    };
    const onResponse = (e: Event) => {
      try {
        const data = JSON.parse(String((e as CustomEvent<unknown>).detail)) as { nonce: string } & Pick<PageContext, "console" | "network">;
        if (data.nonce === nonce) done({ console: data.console ?? [], network: data.network ?? [] });
      } catch {
        // Not ours.
      }
    };
    const timer = window.setTimeout(() => done({ console: [], network: [] }), 300);
    document.addEventListener("inklayer:context-response", onResponse);
    document.dispatchEvent(new CustomEvent("inklayer:context-request", { detail: nonce }));
  });
}

/** The suggestion list for each comment box, kept with the box across re-renders. */
const suggestionLists = new WeakMap<HTMLTextAreaElement, HTMLUListElement>();

/** People picked from @ suggestions in each box, by the name shown, so "@Name" can be saved as <@id>. */
const pickedPeople = new WeakMap<HTMLTextAreaElement, Map<string, string>>();

export function pickedIn(input: HTMLTextAreaElement): Map<string, string> {
  let picked = pickedPeople.get(input);
  if (!picked) pickedPeople.set(input, (picked = new Map()));
  return picked;
}

type Suggestion = { kind: "doc"; doc: DocLookup } | { kind: "person"; person: PersonLookup };

/**
 * Suggestions while typing in a comment or reply box: [[ suggests docs (while docs are on), @ suggests people in the
 * project's organisation. Returns the box wrapped with its suggestion list.
 */
function withSuggestions(input: HTMLTextAreaElement, organizationId: () => string | null, docsOn: boolean): HTMLElement {
  let list = suggestionLists.get(input);
  if (!list) {
    const ul = h("ul", { className: "suggest" });
    ul.hidden = true;
    let items: Suggestion[] = [];
    let active = 0;
    let timer = 0;
    const typed = (): { kind: "doc" | "person"; q: string; start: number } | null => {
      const before = input.value.slice(0, input.selectionStart);
      const doc = docsOn ? /\[\[([^[\]\n|#]*)$/.exec(before) : null;
      if (doc) return { kind: "doc", q: doc[1]!, start: before.length - doc[0].length };
      const person = /(?:^|\s)@([^\s@<>]{0,30})$/.exec(before);
      return person ? { kind: "person", q: person[1]!, start: before.length - person[1]!.length - 1 } : null;
    };
    const show = () => {
      ul.replaceChildren(...items.map((item, i) => h("li", {
        className: i === active ? "active" : "",
        onmousedown: (e: Event) => {
          e.preventDefault();
          pick(item);
        },
      }, ...(item.kind === "doc"
        ? [h("span", { textContent: item.doc.title }), item.doc.folder ? h("span", { className: "muted", textContent: ` ${item.doc.folder}` }) : ""]
        : [h("span", { textContent: `@${item.person.displayName}` }), item.person.fullName !== item.person.displayName ? h("span", { className: "muted", textContent: ` ${item.person.fullName}` }) : ""]))));
      ul.hidden = items.length === 0;
    };
    const pick = (item: Suggestion) => {
      const at = typed();
      if (!at) return;
      const after = input.value.slice(input.selectionStart);
      let insert: string;
      if (item.kind === "doc") {
        insert = `[[${item.doc.title}${after.startsWith("]]") ? "" : "]]"}`;
      } else {
        insert = `@${item.person.displayName} `;
        pickedIn(input).set(item.person.displayName, item.person.id);
      }
      input.value = input.value.slice(0, at.start) + insert + after;
      const end = at.start + insert.length + (item.kind === "doc" && after.startsWith("]]") ? 2 : 0);
      input.setSelectionRange(end, end);
      items = [];
      show();
      input.focus();
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const at = typed();
      const org = organizationId();
      if (!at || !org) {
        items = [];
        show();
        return;
      }
      timer = window.setTimeout(() => {
        const request = at.kind === "doc"
          ? call<DocLookup[]>({ type: "live.docs", orgId: org, q: at.q }).then((docs) => docs.map((doc): Suggestion => ({ kind: "doc", doc })))
          : call<PersonLookup[]>({ type: "live.people", orgId: org, q: at.q }).then((people) => people.map((person): Suggestion => ({ kind: "person", person })));
        request.then((found) => {
          items = typed() === null ? [] : found;
          active = 0;
          show();
        }).catch(() => undefined);
      }, 150);
    });
    // Before the box's own keys (Ctrl+Enter saves, Escape cancels).
    input.addEventListener("keydown", (e) => {
      if (ul.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        active = (active + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        show();
      } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        pick(items[active]!);
      } else if (e.key === "Escape") {
        items = [];
        show();
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    input.addEventListener("blur", () => window.setTimeout(() => {
      items = [];
      show();
    }, 150));
    suggestionLists.set(input, ul);
    list = ul;
  }
  return h("div", { className: "suggest-wrap" }, input, list);
}

/** A line icon (Lucide's paths, 24×24, drawn in the text colour). Built as DOM, not parsed. */
function icon(paths: string[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** A pushpin, for keeping comment bubbles open. */
function pinIcon(): SVGSVGElement {
  return icon(["M12 17v5", "M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"]);
}

/** Six dots: a handle to drag the panel by. */
function gripIcon(): SVGSVGElement {
  return icon(["M9 5h.01", "M9 12h.01", "M9 19h.01", "M15 5h.01", "M15 12h.01", "M15 19h.01"]);
}

/** A bell: notifications. */
function bellIcon(): SVGSVGElement {
  return icon(["M10.268 21a2 2 0 0 0 3.464 0", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"]);
}

/** A dash: minimise the panel. */
function minimiseIcon(): SVGSVGElement {
  return icon(["M5 12h14"]);
}

/** A crossed-out pin: the panel can be dragged. */
function pinOffIcon(): SVGSVGElement {
  return icon(["M12 17v5", "M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89", "m2 2 20 20",
    "M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"]);
}

/** Two speech bubbles: open every comment next to its mark. */
function commentsIcon(): SVGSVGElement {
  return icon(["M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z", "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"]);
}

/** A chain link: share this page. */
function linkIcon(): SVGSVGElement {
  return icon(["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"]);
}

/** An open eye: marks are showing on the page. */
function eyeIcon(): SVGSVGElement {
  return icon(["M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0"]);
}

/** A crossed-out eye: marks are hidden. */
function eyeOffIcon(): SVGSVGElement {
  return icon([
    "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49",
    "M14.084 14.158a3 3 0 0 1-4.242-4.242",
    "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143",
    "m2 2 20 20",
  ]);
}

/** Copies text; pages without a secure context can't use the clipboard API, so fall back to the old way. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { value: text });
    area.style.cssText = "position:fixed;opacity:0;";
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

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

if (!globalThis.__inklayerLive && window.top === window) {
  globalThis.__inklayerLive = true;

  // "Comment on this page" or "Activity log" from the toolbar popup.
  chrome.runtime.onMessage.addListener((message: { type?: string; view?: View }, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "inklayer.live.open") return;
    const view: View = message.view === "activity" ? "activity" : "comments";
    startSession(() => call<LiveInit>({ type: "live.open", url: location.href }), true, view).catch((e: unknown) => window.alert(`Inklayer: ${(e as Error).message}`));
  });

  // "Open on the page" from the web viewer: the address carries a hidden directive naming the comment.
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  const wanted = commentToOpen(location.href, navigation?.name);
  if (wanted && location.href.includes(":~:inklayer=")) {
    // This browser left the directive in the address: take it out, so the site never sees it.
    history.replaceState(history.state, "", location.href.replace(/:~:inklayer=comment:[^&#]*/, "").replace(/#$/, ""));
  }

  if (wanted) {
    void startSession(() => call<LiveInit>({ type: "live.open", url: location.href }), true)
      .then(() => session?.focusComment(wanted))
      .catch(() => undefined);
  } else {
    // Automatically, only if this site has comments (the background checks the origin before asking about this page).
    void startSession(() => call<LiveInit | null>({ type: "live.check", url: location.href }), false).catch(() => undefined);
  }

  // Live cursors: only in tabs where the user turned it on in the toolbar popup. The flag lasts until the tab closes.
  const presence = new PresenceClient(() => Array.from(document.querySelectorAll("inklayer-live, inklayer-bubbles")));
  chrome.runtime.onMessage.addListener((message: { type?: string; on?: boolean }, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "inklayer.presence") return;
    if (message.on) presence.start();
    else presence.stop();
  });
  void chrome.runtime.sendMessage({ type: "presence.status" })
    .then((response: Response<boolean> | undefined) => {
      if (response?.ok && response.value) presence.start();
    })
    .catch(() => undefined);
}

/** The shared colour tokens, scoped to the panel's shadow root. */
const TOKENS = themeTokens.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:root/g, ":host").replace(/\.dark\b/g, ":host(.dark)");

const STYLES = `
  ${TOKENS}
  :host { all: initial; --ring-focus: 0 0 0 3px color-mix(in oklch, var(--ring) 35%, transparent); }
  * { box-sizing: border-box; font: 13px/1.45 "${PANEL_FONT}", system-ui, -apple-system, "Segoe UI", sans-serif; }
  :focus-visible { outline: none; box-shadow: var(--ring-focus); }
  button { cursor: pointer; border: 1px solid var(--border); background: var(--background); color: var(--foreground); border-radius: 999px;
    padding: 4px 10px; font-weight: 500; transition: background-color 120ms, color 120ms; }
  button:hover { background: var(--muted); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--primary); border-color: transparent; color: var(--primary-foreground); }
  button.primary:hover { background: color-mix(in oklch, var(--primary) 80%, transparent); }
  button.link { border: none; background: none; padding: 2px 4px; color: var(--primary); }
  button.link:hover { text-decoration: underline; text-underline-offset: 3px; }
  button.link.danger { color: var(--destructive); }
  /* The dark theme's --primary is a fill colour; as text on the dark panel it needs to be lighter (Tailwind violet-300). */
  :host(.dark) button.link:not(.danger), :host(.dark) .where a { color: oklch(0.811 0.111 293.571); }
  :host(.dark) button:not(.primary, .tool.active, .tab.active) { background: transparent; }
  :host(.dark) button:not(.primary, .link, .tab, .icon, .tool.active):hover { background: var(--muted); }
  .launcher { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border: none; background: var(--primary); color: var(--primary-foreground);
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25); font-weight: 600; }
  .launcher:hover { background: color-mix(in oklch, var(--primary) 88%, black); }
  .count { background: var(--primary-foreground); color: var(--primary); border-radius: 999px; min-width: 22px; padding: 0 7px; text-align: center; font-weight: 700; }
  .count.zero { background: color-mix(in oklch, var(--primary-foreground) 25%, transparent); color: var(--primary-foreground); }
  .panel { width: 344px; max-width: calc(100vw - 16px); box-sizing: border-box; max-height: min(70vh, 640px); overflow: auto; background: var(--popover); color: var(--popover-foreground); border-radius: 22px; padding: 12px;
    box-shadow: 0 20px 40px -12px rgb(0 0 0 / 0.3), 0 0 0 1px color-mix(in oklch, var(--foreground) 8%, transparent); display: flex; flex-direction: column; gap: 10px; }
  /* The icons wrap under the tabs rather than ever leaving the panel. */
  .root { position: relative; }
  .size { flex-wrap: wrap; justify-content: space-between; font-size: 12px; }
  .size-bar { justify-content: space-between; gap: 8px; padding: 6px 10px; border-radius: 12px; font-size: 12px; background: color-mix(in oklch, var(--primary) 8%, transparent); }
  .shared { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 14px; background: color-mix(in oklch, var(--primary) 8%, transparent); }
  .shared .row { justify-content: space-between; }
  .shared .close { padding: 0 6px; font-size: 16px; line-height: 1; }
  .shared .link-row { gap: 6px; }
  .share-url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--primary); user-select: all; }
  :host(.dark) .share-url { color: oklch(0.811 0.111 293.571); }
  /* One line: the tabs give way (shortening their labels) before anything leaves the panel. */
  .header { display: flex; align-items: center; gap: 2px; }
  .header .tabs { flex: 0 1 auto; min-width: 0; }
  .header .tab { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .actions { display: flex; align-items: center; gap: 0; margin-left: auto; flex: none; }
  .actions .icon.svg { padding: 4px 5px; border-width: 0; }
  .corner-pin { position: absolute; top: -7px; right: -7px; width: 24px; height: 24px; padding: 0; display: grid; place-items: center; border-radius: 999px;
    background: var(--popover); color: var(--muted-foreground); box-shadow: 0 2px 6px rgb(0 0 0 / 0.25), 0 0 0 1px color-mix(in oklch, var(--foreground) 10%, transparent); }
  .corner-pin svg { width: 13px; height: 13px; }
  .corner-pin:hover { color: var(--foreground); background: var(--popover); }
  .corner-pin.on { color: var(--primary); }
  :host(.dark) .corner-pin { background: var(--popover); }
  :host(.dark) .corner-pin.on { color: oklch(0.811 0.111 293.571); }
  .icon.bell { position: relative; }
  .icon.bell .badge { position: absolute; top: -3px; right: -4px; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; background: var(--primary);
    color: var(--primary-foreground); font-size: 10px; font-weight: 700; line-height: 15px; text-align: center; }
  .bell-count { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; font-weight: 700; }
  .bell-count svg { width: 14px; height: 14px; }
  .inbox-head { justify-content: space-between; }
  .inbox .item.read { opacity: 0.7; }
  .unread-dot { width: 7px; height: 7px; border-radius: 999px; background: var(--primary); flex: none; }
  .clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .header.movable { cursor: grab; touch-action: none; user-select: none; }
  .grip { display: grid; place-items: center; color: var(--muted-foreground); margin-left: -4px; }
  .grip svg { width: 16px; height: 16px; stroke-width: 3; }
  .launcher.movable { cursor: grab; touch-action: none; }
  .header.dragging, .launcher.dragging { cursor: grabbing; }
  .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--muted); }
  .tab { border: none; background: none; padding: 3px 10px; color: var(--muted-foreground); font-weight: 500; }
  .tab:hover { background: none; color: var(--foreground); }
  .tab.active { background: var(--background); color: var(--foreground); box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }
  :host(.dark) .tab.active { background: var(--input); }
  .filters select { flex: 1; min-width: 0; }
  .activity .item { cursor: default; }
  .activity .item.here { cursor: pointer; }
  .grow-left { margin-left: auto; white-space: nowrap; }
  .where { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .where a { color: var(--primary); text-decoration: none; }
  .where a:hover { text-decoration: underline; }
  .error-detail { color: var(--destructive); font-family: ui-monospace, monospace; font-size: 12px; }
  .grow { flex: 1; }
  .target { display: grid; gap: 4px; color: var(--muted-foreground); font-size: 12px; }
  select { appearance: auto; border: 1px solid transparent; border-radius: 999px; padding: 5px 10px; background: color-mix(in oklch, var(--input) 50%, transparent);
    color: var(--foreground); max-width: 100%; }
  select option { background: Canvas; color: CanvasText; }
  .icon { padding: 2px 10px; border-color: transparent; background: none; color: var(--muted-foreground); }
  .icon:hover { color: var(--foreground); }
  .icon.svg { display: grid; place-items: center; padding: 4px 6px; }
  .icon.svg svg { width: 16px; height: 16px; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; }
  .tool.active, .tool.active:hover { background: var(--primary); color: var(--primary-foreground); border-color: transparent; }
  .colors { display: flex; gap: 8px; padding: 2px; }
  .swatch { width: 20px; height: 20px; padding: 0; border-radius: 50%; border: 2px solid var(--popover); box-shadow: 0 0 0 1px var(--border); }
  .swatch.active { box-shadow: 0 0 0 2px var(--foreground); }
  .hint, .muted, .empty { color: var(--muted-foreground); margin: 0; font-size: 12px; }
  .error { color: var(--destructive); margin: 0; }
  .draft { display: flex; flex-direction: column; gap: 8px; padding: 10px; border-radius: 16px; background: var(--muted); }
  textarea { width: 100%; resize: vertical; border: 1px solid transparent; border-radius: 14px; padding: 8px 10px; color: var(--foreground);
    background: var(--background); }
  textarea::placeholder { color: var(--muted-foreground); }
  .row { display: flex; gap: 6px; align-items: center; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .item { padding: 8px 10px; border-radius: 14px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .item:hover { background: color-mix(in oklch, var(--muted) 70%, transparent); }
  .item.selected { background: color-mix(in oklch, var(--primary) 12%, transparent); }
  .item.resolved { opacity: 0.6; }
  .meta { display: flex; align-items: center; gap: 6px; }
  .badge { color: #fff; border-radius: 11px; min-width: 20px; height: 20px; padding: 0 6px; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; }
  .warn { color: #92400e; background: #fef3c7; border-radius: 999px; padding: 0 6px; font-size: 11px; }
  .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .address { color: var(--muted-foreground); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .scope { border: none; margin: 0; padding: 0; display: grid; gap: 2px; }
  .scope legend { padding: 0; margin-bottom: 4px; color: var(--muted-foreground); font-size: 12px; }
  .scope label { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 12px; cursor: pointer; }
  .scope label:hover { background: color-mix(in oklch, var(--background) 60%, transparent); }
  .scope label:has(input:checked) { background: var(--background); }
  .scope input { accent-color: var(--primary); margin: 2px 0 0; }
  .scope-text { display: grid; gap: 1px; min-width: 0; }
  .actions { gap: 2px; }
  .attach { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted-foreground); }
  canvas.shot { display: block; width: 100%; max-height: 180px; object-fit: contain; object-position: left; border-radius: 10px; border: 1px solid var(--border); cursor: zoom-in; }
  .lightbox { position: fixed; inset: 0; z-index: 10; display: grid; place-items: center; background: rgb(0 0 0 / .7); cursor: zoom-out; }
  .shot-large { max-width: 92vw; max-height: 88vh; border-radius: 12px; box-shadow: 0 10px 40px rgb(0 0 0 / .5); }
  details.context { font-size: 12px; }
  details.context summary { cursor: pointer; color: var(--muted-foreground); }
  details.context ul { margin: 4px 0 0; padding-left: 16px; max-height: 140px; overflow: auto; overflow-wrap: anywhere; }
  details.context li.error { color: var(--destructive); }
  .icon.on { color: var(--primary); background: color-mix(in oklab, var(--primary) 12%, transparent); }
  .replies-count { margin: 0; font-size: 12px; }
  .mention { color: var(--primary); font-weight: 600; background: color-mix(in oklab, var(--primary) 10%, transparent); border-radius: 6px; padding: 0 3px; }
  .doclink { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
  .doclink.missing { color: var(--muted-foreground); text-decoration-style: dashed; }
  .mentions { margin: 0; font-size: 12px; }
  .issues { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; }
  .issues a.issue { border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; color: inherit; text-decoration: none; }
  .issues a.issue:hover { background: var(--muted); }
  .issues a.issue.open { color: #1a7f37; }
  .issues a.issue.closed { color: #8250df; }
  .issues select.issue-pick { font: inherit; font-size: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--background); color: inherit; }
  .mentions a { color: var(--primary); }
  .suggest-wrap { position: relative; }
  .suggest { position: absolute; left: 0; right: 0; top: 100%; z-index: 1; margin: 4px 0 0; padding: 4px; list-style: none;
    background: var(--popover, var(--background)); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 6px 20px rgb(0 0 0 / .12); }
  .suggest li { padding: 6px 8px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }
  .suggest li.active, .suggest li:hover { background: var(--muted); }
`;
