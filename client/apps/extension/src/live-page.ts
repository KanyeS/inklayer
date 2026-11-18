import {
  Overlay, type Anchor, type AnchorQuality, type AnnotationKind, type Draft, type Geometry, type OverlayAnnotation, type OverlayMessage, type Tool,
} from "@inklayer/overlay";
import type { LiveAnnotation, LiveInit, LivePage, LiveProject, LiveRequest } from "./lib/live";
import type { Response } from "./lib/messages";

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
  #open = false;
  #marksVisible = true;
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
    this.#root = document.createElement("div");
    this.#shadow.append(this.#root);
    // Typing in the panel shouldn't trigger the page's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"] as const) this.#root.addEventListener(type, (e) => e.stopPropagation());

    this.#overlay = new Overlay(document, (m) => this.#onOverlay(m), { blockLinks: false, ignoreEventsFrom: [this.#host] });
    document.documentElement.append(this.#host);
  }

  /** Expands the panel, e.g. when the user picks "Comment on this page" in the toolbar. */
  open(): void {
    this.#open = true;
    this.#render();
  }

  async start(open: boolean): Promise<void> {
    this.#open = open;
    this.#syncOverlay();
    this.#render();

    // Single-page apps change the URL without reloading; some also replace parts of html.
    setInterval(() => {
      if (this.#overlay.ensureAttached() || !this.#host.isConnected) document.documentElement.append(this.#host);
      if (location.href !== this.#href) {
        this.#href = location.href;
        this.#draft = null;
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
    }
  }

  #setTool(tool: Tool): void {
    this.#tool = tool;
    this.#overlay.handle({ type: "setTool", tool, color: this.#color });
    this.#render();
  }

  #cancelDraft(): void {
    this.#draft = null;
    this.#draftInput = null;
    this.#overlay.handle({ type: "clearDraft" });
    this.#render();
  }

  async #saveDraft(): Promise<void> {
    const draft = this.#draft;
    const body = this.#draftInput?.value.trim() ?? "";
    const target = this.#target;
    if (!draft || !target || this.#busy) return;
    await this.#mutate(async () => {
      const created = await call<LiveAnnotation>({
        type: "live.create", projectId: target.id, url: location.href,
        kind: draft.kind, body, color: this.#color, anchor: draft.anchor, geometry: draft.geometry, viewportWidth: draft.viewportWidth,
      });
      this.#draft = null;
      this.#draftInput = null;
      this.#selected = created.id;
      this.#overlay.handle({ type: "clearDraft" });
      this.#setTool("select");
    });
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
  }

  #draw(): void {
    if (!this.#open) {
      const open = this.#annotations.filter((a) => a.status === "Open").length;
      this.#root.replaceChildren(h("button", { className: "launcher", title: "Inklayer comments on this page", onclick: () => { this.#open = true; this.#render(); } },
        "Inklayer", h("span", { className: open ? "count" : "count zero", textContent: String(open) })));
      return;
    }

    const header = h("div", { className: "header" },
      h("strong", { className: "grow", textContent: "Inklayer" }),
      h("button", { className: "icon", title: this.#marksVisible ? "Hide marks on the page" : "Show marks on the page", textContent: this.#marksVisible ? "Hide" : "Show",
        onclick: () => { this.#marksVisible = !this.#marksVisible; this.#overlay.setVisible(this.#marksVisible); this.#render(); } }),
      h("button", { className: "icon", title: "Minimise", textContent: "–", onclick: () => { this.#open = false; this.#render(); } }));

    const parts: Node[] = [header];

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
        h("strong", { textContent: "New comment" }), this.#draftInput,
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

    this.#root.replaceChildren(h("div", { className: "panel" }, ...parts));
  }

  #item(a: PageAnnotation): HTMLLIElement {
    const resolved = a.status === "Resolved";
    const badge = h("span", { className: "badge", textContent: String(this.#labelOf(a.id)) });
    badge.style.background = a.color;
    const meta = h("div", { className: "meta" }, badge, h("strong", { textContent: a.author.displayName || "Someone" }), h("span", { className: "muted", textContent: timeAgo(a.createdAt) }));
    if (new Set(this.#annotations.map((x) => x.projectId)).size > 1) meta.append(h("span", { className: "muted", textContent: `· ${this.#projects.get(a.projectId)?.name ?? ""}` }));
    if (this.#quality[a.id] === "orphaned") meta.append(h("span", { className: "warn", textContent: "moved", title: "The element this was attached to has changed; shown where it originally was." }));

    const item = h("li", { className: ["item", resolved ? "resolved" : "", a.id === this.#selected ? "selected" : ""].join(" "), onclick: () => {
      this.#selected = a.id;
      this.#overlay.handle({ type: "select", id: a.id, scroll: true });
      this.#render();
    } });
    item.dataset.id = a.id;
    item.append(meta);

    if (this.#editing?.id === a.id) {
      const input = this.#editing.input;
      item.append(input, h("div", { className: "row" },
        h("button", { className: "primary", textContent: "Save", disabled: this.#busy, onclick: (e: Event) => {
          e.stopPropagation();
          const body = input.value;
          this.#editing = null;
          void this.#mutate(() => call({ type: "live.update", id: a.id, version: a.version, body }));
        } }),
        h("button", { textContent: "Cancel", onclick: (e: Event) => { e.stopPropagation(); this.#editing = null; this.#render(); } })));
      return item;
    }

    if (a.body) item.append(h("p", { className: "body", textContent: a.body }));
    const actions = h("div", { className: "row actions" });
    const act = (label: string, run: () => Promise<unknown>) => h("button", { className: "link", textContent: label, disabled: this.#busy, onclick: (e: Event) => { e.stopPropagation(); void this.#mutate(run); } });
    if (this.#canCommentIn(a.projectId)) {
      actions.append(act(resolved ? "Reopen" : "Resolve", () => call({ type: "live.update", id: a.id, version: a.version, status: resolved ? "Open" : "Resolved" })));
    }
    if (a.canEdit) {
      actions.append(h("button", { className: "link", textContent: "Edit", onclick: (e: Event) => {
        e.stopPropagation();
        this.#editing = { id: a.id, input: h("textarea", { value: a.body, rows: 3, onclick: (ev: Event) => ev.stopPropagation() }) };
        this.#render();
        this.#editing.input.focus();
      } }));
    }
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

/* ---------------------------------------------------------------- start-up */

let session: LiveSession | null = null;
let starting: Promise<void> | null = null;

/** Starts the session with comments already loaded, or opens it if it's running. */
function startSession(load: () => Promise<LiveInit | null>, open: boolean): Promise<void> {
  if (session) {
    if (open) session.open();
    return Promise.resolve();
  }
  starting ??= (async () => {
    const init = await load();
    if (!init) return;
    session = new LiveSession(init);
    await session.start(open);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

if (!globalThis.__inklayerLive && window.top === window) {
  globalThis.__inklayerLive = true;

  // "Comment on this page" from the toolbar popup.
  chrome.runtime.onMessage.addListener((message: { type?: string }, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "inklayer.live.open") return;
    startSession(() => call<LiveInit>({ type: "live.open", url: location.href }), true).catch((e: unknown) => window.alert(`Inklayer: ${(e as Error).message}`));
  });

  // Automatically, only if this site has comments (the background checks the origin before asking about this page).
  void startSession(() => call<LiveInit | null>({ type: "live.check", url: location.href }), false).catch(() => undefined);
}

const STYLES = `
  :host { all: initial; }
  * { box-sizing: border-box; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
  button { cursor: pointer; border: 1px solid #d1d5db; background: #fff; color: #111827; border-radius: 6px; padding: 4px 8px; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
  button.link { border: none; background: none; padding: 2px 4px; color: #4f46e5; }
  button.link.danger { color: #b91c1c; }
  .launcher { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; border: none; background: #111827; color: #fff;
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.25); font-weight: 600; }
  .count { background: #f59e0b; color: #111827; border-radius: 999px; min-width: 20px; padding: 0 6px; text-align: center; font-weight: 700; }
  .count.zero { background: #374151; color: #d1d5db; }
  .panel { width: 320px; max-height: min(70vh, 640px); overflow: auto; background: #fff; color: #111827; border-radius: 12px; padding: 10px;
    box-shadow: 0 10px 30px rgb(0 0 0 / 0.25), 0 0 0 1px rgb(0 0 0 / 0.06); display: flex; flex-direction: column; gap: 8px; }
  .header { display: flex; align-items: center; gap: 6px; }
  .grow { flex: 1; }
  .target { display: grid; gap: 2px; color: #6b7280; font-size: 12px; }
  select { border: 1px solid #d1d5db; border-radius: 6px; padding: 4px; background: #fff; color: #111827; max-width: 100%; }
  .icon { padding: 2px 8px; }
  .tools { display: flex; flex-wrap: wrap; gap: 4px; }
  .tool.active { background: #111827; color: #fff; border-color: #111827; }
  .colors { display: flex; gap: 6px; }
  .swatch { width: 20px; height: 20px; padding: 0; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #d1d5db; }
  .swatch.active { box-shadow: 0 0 0 2px #111827; }
  .hint, .muted, .empty { color: #6b7280; margin: 0; font-size: 12px; }
  .error { color: #b91c1c; margin: 0; }
  .draft { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px; background: #eef2ff; }
  textarea { width: 100%; resize: vertical; border: 1px solid #d1d5db; border-radius: 6px; padding: 6px; color: #111827; background: #fff; }
  .row { display: flex; gap: 6px; align-items: center; }
  .list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .item { padding: 6px 8px; border-radius: 8px; cursor: pointer; display: flex; flex-direction: column; gap: 4px; }
  .item:hover { background: #f9fafb; }
  .item.selected { background: #eef2ff; }
  .item.resolved { opacity: 0.6; }
  .meta { display: flex; align-items: center; gap: 6px; }
  .badge { color: #fff; border-radius: 11px; min-width: 20px; height: 20px; padding: 0 6px; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; }
  .warn { color: #92400e; background: #fef3c7; border-radius: 4px; padding: 0 4px; font-size: 11px; }
  .body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .actions { gap: 2px; }
`;
