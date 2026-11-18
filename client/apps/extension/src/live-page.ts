import {
  Overlay, commentParts, commentToOpen, type Anchor, type AnchorQuality, type AnnotationKind, type Draft, type Geometry, type OverlayAnnotation, type OverlayMessage, type Tool,
} from "@inklayer/overlay";
import type { ActivityItem, ActivityPage, DocLookup, LiveAnnotation, LiveInit, LivePage, LiveProject, LiveRequest } from "./lib/live";
import type { Response } from "./lib/messages";
import themeTokens from "@inklayer/ui/tokens.css?inline";
import { PresenceClient } from "./presence-page";

type View = "comments" | "activity";

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
};
const DOC_VERBS: Record<string, string> = {
  created: "created a doc",
  edited: "edited a doc",
  renamed: "renamed a doc",
  moved: "moved a doc",
  deleted: "deleted a doc",
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
    this.#shadow.append(this.#root);
    // Typing in the panel shouldn't trigger the page's keyboard shortcuts.
    for (const type of ["keydown", "keyup", "keypress"] as const) this.#root.addEventListener(type, (e) => e.stopPropagation());

    this.#overlay = new Overlay(document, (m) => this.#onOverlay(m), { ignoreEventsFrom: [this.#host] });
    document.documentElement.append(this.#host);
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
    const body = this.#draftInput?.value.trim() ?? "";
    const target = this.#target;
    if (!draft || !target || this.#busy) return;
    await this.#mutate(async () => {
      const created = await call<LiveAnnotation>({
        type: "live.create", projectId: target.id, url: location.href,
        ...this.#chosenScope(),
        kind: draft.kind, body, color: this.#color, anchor: draft.anchor, geometry: draft.geometry, viewportWidth: draft.viewportWidth,
      });
      this.#draft = null;
      this.#draftInput = null;
      this.#selected = created.id;
      this.#overlay.handle({ type: "clearDraft" });
      this.#setTool("select");
    });
  }

  /* ------------------------------------------------------------------ activity */

  #setView(view: View): void {
    this.#view = view;
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
    const p = h("p", { className: "body" });
    for (const part of commentParts(a.body, a.docLinks ?? [])) {
      if ("text" in part) p.append(part.text);
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
      who ? h("strong", { textContent: who }) : "", h("span", { className: item.kind === "errors" ? "error" : "", textContent: who ? ` ${verb}` : verb }),
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
      li.onclick = () => {
        // Resolved comments are hidden by default; show them if that's the one being opened.
        if (this.#annotations.find((a) => a.id === item.annotationId)?.status === "Resolved" && !this.#showResolved) {
          this.#showResolved = true;
          this.#syncOverlay();
        }
        this.#selected = item.annotationId;
        this.#overlay.handle({ type: "select", id: item.annotationId, scroll: true });
        this.#setView("comments");
      };
    }
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
  }

  #draw(): void {
    if (!this.#open) {
      const open = this.#annotations.filter((a) => a.status === "Open").length;
      this.#root.replaceChildren(h("button", { className: "launcher", title: "Inklayer comments on this page", onclick: () => { this.#open = true; this.#render(); } },
        "Inklayer", h("span", { className: open ? "count" : "count zero", textContent: String(open) })));
      return;
    }

    const tab = (view: View, label: string) =>
      h("button", { className: this.#view === view ? "tab active" : "tab", textContent: label, onclick: () => this.#setView(view) });
    const header = h("div", { className: "header" },
      h("div", { className: "tabs grow" }, tab("comments", "Comments"), tab("activity", "Activity")),
      h("button", { className: "icon", title: this.#marksVisible ? "Hide marks on the page" : "Show marks on the page", textContent: this.#marksVisible ? "Hide" : "Show",
        onclick: () => { this.#marksVisible = !this.#marksVisible; this.#overlay.setVisible(this.#marksVisible); this.#render(); } }),
      h("button", { className: "icon", title: "Minimise", textContent: "–", onclick: () => { this.#open = false; this.#render(); } }));

    const parts: Node[] = [header];
    if (this.#view === "activity") {
      this.#root.replaceChildren(h("div", { className: "panel" }, ...parts, ...this.#activityParts()));
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
        h("strong", { textContent: "New comment" }), withDocSuggestions(this.#draftInput, () => this.#target?.organizationId ?? null), this.#scopeChooser(),
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
    // On an address with a query or #hash, say whether each comment is for every version of the page or just this one.
    if (location.search.length > 1 || location.hash.length > 1) {
      item.append(h("span", { className: "address", textContent: addressOf(a.pageUrl), title: a.pageUrl ?? "" }));
    }

    if (this.#editing?.id === a.id) {
      const input = this.#editing.input;
      item.append(withDocSuggestions(input, () => this.#projects.get(a.projectId)?.organizationId ?? null), h("div", { className: "row" },
        h("button", { className: "primary", textContent: "Save", disabled: this.#busy, onclick: (e: Event) => {
          e.stopPropagation();
          const body = input.value;
          this.#editing = null;
          void this.#mutate(() => call({ type: "live.update", id: a.id, version: a.version, body }));
        } }),
        h("button", { textContent: "Cancel", onclick: (e: Event) => { e.stopPropagation(); this.#editing = null; this.#render(); } })));
      return item;
    }

    if (a.body) item.append(this.#bodyOf(a));
    if (a.mentionedIn?.length) {
      const mentions = h("p", { className: "muted mentions" }, "Mentioned in ");
      a.mentionedIn.forEach((d, i) => {
        if (i > 0) mentions.append(", ");
        mentions.append(h("a", { href: this.#docUrl(a.organizationId, d.docId), target: "_blank", rel: "noopener", textContent: d.title, onclick: (e: Event) => e.stopPropagation() }));
      });
      item.append(mentions);
    }
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
/** The suggestion list for each comment box, kept with the box across re-renders. */
const suggestionLists = new WeakMap<HTMLTextAreaElement, HTMLUListElement>();

/**
 * Typing [[ in a comment box suggests docs from the project's organisation; picking one completes the link.
 * Returns the box wrapped with its suggestion list.
 */
function withDocSuggestions(input: HTMLTextAreaElement, organizationId: () => string | null): HTMLElement {
  let list = suggestionLists.get(input);
  if (!list) {
    const ul = h("ul", { className: "suggest" });
    ul.hidden = true;
    let docs: DocLookup[] = [];
    let active = 0;
    let timer = 0;
    const typed = () => /\[\[([^[\]\n|#]*)$/.exec(input.value.slice(0, input.selectionStart))?.[1] ?? null;
    const show = () => {
      ul.replaceChildren(...docs.map((d, i) => h("li", {
        className: i === active ? "active" : "",
        onmousedown: (e: Event) => {
          e.preventDefault();
          pick(d);
        },
      }, h("span", { textContent: d.title }), d.folder ? h("span", { className: "muted", textContent: ` ${d.folder}` }) : "")));
      ul.hidden = docs.length === 0;
    };
    const pick = (d: DocLookup) => {
      const caret = input.selectionStart;
      const start = input.value.slice(0, caret).lastIndexOf("[[");
      const after = input.value.slice(caret);
      const closed = after.startsWith("]]");
      input.value = `${input.value.slice(0, start)}[[${d.title}${closed ? "" : "]]"}${after}`;
      const end = start + 2 + d.title.length + 2;
      input.setSelectionRange(end, end);
      docs = [];
      show();
      input.focus();
    };
    input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = typed();
      const org = organizationId();
      if (q === null || !org) {
        docs = [];
        show();
        return;
      }
      timer = window.setTimeout(() => {
        call<DocLookup[]>({ type: "live.docs", orgId: org, q }).then((found) => {
          docs = typed() === null ? [] : found;
          active = 0;
          show();
        }).catch(() => undefined);
      }, 150);
    });
    // Before the box's own keys (Ctrl+Enter saves, Escape cancels).
    input.addEventListener("keydown", (e) => {
      if (ul.hidden) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        active = (active + (e.key === "ArrowDown" ? 1 : docs.length - 1)) % docs.length;
        show();
      } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
        pick(docs[active]!);
      } else if (e.key === "Escape") {
        docs = [];
        show();
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    input.addEventListener("blur", () => window.setTimeout(() => {
      docs = [];
      show();
    }, 150));
    suggestionLists.set(input, ul);
    list = ul;
  }
  return h("div", { className: "suggest-wrap" }, input, list);
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
  const presence = new PresenceClient(() => Array.from(document.querySelectorAll("inklayer-live")));
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
  .panel { width: 330px; max-height: min(70vh, 640px); overflow: auto; background: var(--popover); color: var(--popover-foreground); border-radius: 22px; padding: 12px;
    box-shadow: 0 20px 40px -12px rgb(0 0 0 / 0.3), 0 0 0 1px color-mix(in oklch, var(--foreground) 8%, transparent); display: flex; flex-direction: column; gap: 10px; }
  .header { display: flex; align-items: center; gap: 4px; }
  .tabs { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--muted); }
  .tab { border: none; background: none; padding: 3px 12px; color: var(--muted-foreground); font-weight: 500; }
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
  .doclink { color: var(--primary); text-decoration: underline; text-underline-offset: 3px; }
  .doclink.missing { color: var(--muted-foreground); text-decoration-style: dashed; }
  .mentions { margin: 0; font-size: 12px; }
  .mentions a { color: var(--primary); }
  .suggest-wrap { position: relative; }
  .suggest { position: absolute; left: 0; right: 0; top: 100%; z-index: 1; margin: 4px 0 0; padding: 4px; list-style: none;
    background: var(--popover, var(--background)); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 6px 20px rgb(0 0 0 / .12); }
  .suggest li { padding: 6px 8px; border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; gap: 8px; }
  .suggest li.active, .suggest li:hover { background: var(--muted); }
`;
