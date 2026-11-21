/** @jsxImportSource preact */
import {
  type Anchor,
  type AnchorQuality,
  type AnnotationKind,
  copyText,
  type Draft,
  type Geometry,
  Overlay,
  type OverlayAnnotation,
  type OverlayMessage,
  shadowTokens,
  type Tool,
} from "@inklayer/overlay";
import themeTokens from "@inklayer/ui/tokens.css?inline";
import { type ComponentChild, render } from "preact";
import type { LiveAnnotation, LiveInit, LivePage, LiveProject, PullRequestPage } from "../lib/live";
import type { RecorderState } from "../lib/recorder-protocol";
import { call, messageOf, remember } from "./call";
import { Captures } from "./captures";
import { Carry, scopeFor } from "./carry";
import type { PageAnnotation, PanelContext, View } from "./context";
import type { Scope } from "./format";
import { HoverBubbles } from "./hover-bubbles";
import { COLORS } from "./labels";
import { NextFrame } from "./next-frame";
import { panelHost } from "./page-io";
import { PanelMover } from "./panel-mover";
import panelCss from "./styles/panel.css?inline";
import { draftBody, draftOf, EMPTY_DRAFT, type TextDraft } from "./suggestions";
import { ActivityView } from "./views/activity";
import { cornerPin, header, launcher, type SharedLink, sharedBox, sizeBar } from "./views/chrome";
import { bubbleContent, type CommentActions, listEntry } from "./views/comment";
import { CommentParts } from "./views/comment-parts";
import { cannotComment, draftBox, draftInput, scopeChooser, toolbar } from "./views/composer";
import { InboxView } from "./views/inbox";
import { pullRequestBox } from "./views/pull-request";
import { SizeMatcher } from "./window-size";

/** The panel's and bubbles' styles: the theme's tokens scoped to the shadow root, then the panel's own CSS. */
export const PANEL_STYLES = `${shadowTokens(themeTokens)}\n${panelCss}`;

const REANCHOR_DELAY_MS = 400;
const REANCHOR_MAX_WAIT_MS = 1500;
const REFRESH_EVERY_MS = 60_000;
const WATCH_ADDRESS_MS = 1000;
const NOTE_SHOWN_MS = 8000;
const RESIZE_REDRAW_MS = 200;

/** Settings remembered in the extension's storage, the same on every site. */
const STORED_KEYS = ["bubblesOpen", "attachContext", "panelPosition", "panelPinned", "unreadCount", "fullPage"];

/**
 * Live mode on a real page.
 * <ul>
 * <li>Draws the comments for this page from all of the user's projects with the shared overlay, re-anchored to the page's current DOM.</li>
 * <li>Adds a small panel, in a closed shadow root, for the tools and the comment list.</li>
 * <li>All API calls go through the background worker, which checks them against this page's origin; the page never sees a token.</li>
 * </ul>
 * Everything shown is rendered as text by Preact, never parsed as HTML. This class keeps the state and decides what's
 * shown; the panel's pieces come from the modules in views/, and bubbles, dragging and bug context have modules of their own.
 */
export class LiveSession {
  readonly #init: LiveInit;
  /** On a pull request's page: the comments linked to it. */
  #pullRequest: PullRequestPage | null;
  readonly #host: HTMLElement;
  readonly #shadow: ShadowRoot;
  readonly #root: HTMLDivElement;
  readonly #overlay: Overlay;
  readonly #bubbles: HoverBubbles;
  readonly #mover: PanelMover;
  readonly #ctx: PanelContext;
  readonly #parts: CommentParts;
  readonly #activity: ActivityView;
  readonly #inbox: InboxView;

  readonly #projects: Map<string, LiveProject>;
  /** Where new comments go: a project the user can comment in, or null if they can only view. */
  #target: LiveProject | null;
  #annotations: PageAnnotation[] = [];
  #quality: Record<string, AnchorQuality> = {};

  // Making a comment
  #draft: Draft | null = null;
  #draftText: TextDraft = EMPTY_DRAFT;
  /** Counts drafts, so each new one gets a fresh (and focused) comment box. */
  #draftNumber = 0;
  #editing: { id: string; draft: TextDraft } | null = null;
  #tool: Tool = "select";
  #color: string = COLORS[0];
  #scope: Scope = { query: false, hash: false };
  /** Attach a screenshot and page details to new comments (remembered; on unless turned off). */
  readonly #nextFrame = new NextFrame((bubbles) => {
    this.#mover.place();
    if (bubbles) this.#bubbles.render();
  });
  /** The tab is being recorded: the comment tool is paused (see recordingTab). */
  #recordingTab = false;
  /** The screenshot, page details, full page and recording sent with a new comment. */
  readonly #captures = new Captures(
    () => this.#init.features.bugContext,
    () => this.#render(),
    (note) => this.#flashNote(note),
    () => this.#carry.start(),
  );
  /** The comment being written, kept with the tab's recording so it can be picked up on the next page. */
  /** The comment being written, kept with the tab's recording so it can be picked up on the next page. */
  readonly #carry = new Carry(() => this.#draft && this.#target && { draft: this.#draft, ...this.#writing() });

  // What's shown
  #open = false;
  #view: View = "comments";
  #selected: string | null = null;
  #showResolved = false;
  #marksVisible = true;
  /** Every comment's bubble open, not just on hover (the user's choice, remembered). */
  #bubblesOpen = false;
  #busy = false;
  #error = "";
  /** A short message under the header (sharing results, how to move the panel). */
  #note = "";
  /** The last "Share this page" link, shown until closed. */
  #shared: SharedLink | null = null;
  /** This window resized to a commenter's size; "Back to my size" puts it back. */
  readonly #size = new SizeMatcher(
    (text) => this.#flashNote(text),
    () => this.#render(),
  );

  // Following the page
  #href = location.href;
  #reanchorTimer = 0;
  #reanchorSince = 0;

  constructor(init: LiveInit) {
    this.#init = init;
    this.#pullRequest = init.pullRequest;
    this.#projects = new Map(init.projects.map((p) => [p.id, p]));
    const commentable = init.projects.filter((p) => p.canComment);
    this.#target = commentable.find((p) => p.id === init.lastProjectId) ?? commentable[0] ?? null;
    this.#setPages(init.pages);

    [this.#host, this.#shadow, this.#root] = panelHost(PANEL_STYLES);

    this.#ctx = this.#panelContext();
    this.#mover = new PanelMover(
      this.#host,
      (text) => this.#flashNote(text),
      () => this.#render(),
    );
    this.#parts = new CommentParts(this.#ctx, {
      canCommentIn: (projectId) => this.#canCommentIn(projectId),
      organizationOf: (projectId) => this.#organizationOf(projectId),
      lightboxParent: this.#shadow,
      matchSize: (id, width, height, zoom) =>
        void this.#size.match(
          { width, height },
          zoom,
          () => this.#overlay.handle({ type: "select", id, scroll: true }),
          REANCHOR_MAX_WAIT_MS,
        ),
    });
    this.#bubbles = new HoverBubbles(PANEL_STYLES, {
      visible: () => this.#visible(),
      marksVisible: () => this.#marksVisible,
      allOpen: () => this.#bubblesOpen,
      hoverOpens: () => this.#tool === "select",
      keepOpen: (id) => this.#parts.hasReplyDraft("bubble", id),
      content: (a, pinned, togglePin) =>
        bubbleContent(this.#ctx, this.#parts, a, {
          pinned,
          canComment: this.#canCommentIn(a.projectId),
          onTogglePin: togglePin,
          onShowInList: () => this.focusComment(a.id),
          actions: this.#actionsFor(a),
        }),
    });
    this.#overlay = new Overlay(document, (m) => this.#onOverlay(m), {
      ignoreEventsFrom: [this.#host, this.#bubbles.host],
    });
    this.#activity = new ActivityView(this.#ctx);
    this.#inbox = new InboxView(this.#ctx);

    document.documentElement.append(this.#host);
    this.#restoreSettings();
    this.#followSettings();
    this.#followWindowSize();
  }

  /** What the views in views/ may see and do. */
  #panelContext(): PanelContext {
    const session = this;
    return {
      init: this.#init,
      get busy() {
        return session.#busy;
      },
      render: () => this.#render(),
      mutate: (action) => void this.#mutate(action),
      flashNote: (text) => this.#flashNote(text),
      showError: (message) => {
        this.#error = message;
        this.#render();
      },
      isOnThisPage: (id) => this.#annotations.some((a) => a.id === id),
      showOnPage: (id) => this.#showOnPage(id),
    };
  }

  /* ------------------------------------------------------------------ public */

  /** A recording is ready: attach it, or (made away from the comment's page) go back there, where it's picked up. */
  recordingReady(id: string, seconds: number): void {
    if (this.#carry.from) this.#carry.goBack();
    else if (this.#captures.recordingReady(id, seconds, this.#draft !== null)) {
      this.#open = true;
      this.#render();
    }
  }

  /** The tab's recording, picked up on this page: its bar, and the comment it's for (maybe from another page). */
  resumeRecording(state: RecorderState): void {
    const kept = state.draft;
    if (kept && (!this.#draft || this.#carry.active)) {
      ({
        draft: this.#draft,
        text: this.#draftText,
        color: this.#color,
        scope: this.#scope,
      } = this.#carry.pickUp(kept));
      this.#draftNumber++;
      this.#target = this.#projects.get(kept.projectId) ?? this.#target;
    }
    this.#carry.active = true;
    this.#captures.resume(state);
    this.recordingTab(state.phase === "recording");
    this.#open = state.phase !== "recording";
    this.#render();
  }

  /** Back to a page whose comment was since saved or cancelled on another page of the tab: it's gone here too. */
  recorderGone(): void {
    if (!this.#carry.active) return;
    this.#carry.drop();
    this.#captures.forget();
    this.#draft = null;
    this.#draftText = EMPTY_DRAFT;
    this.#overlay.handle({ type: "clearDraft" });
    this.recordingTab(false);
    this.#render();
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
    this.#scrollToEntry(id);
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
    setInterval(() => this.#followAddress(), WATCH_ADDRESS_MS);
    const refreshIfIdle = () => {
      if (document.visibilityState === "visible" && !this.#draft && !this.#editing) void this.#load();
    };
    setInterval(refreshIfIdle, REFRESH_EVERY_MS);
    document.addEventListener("visibilitychange", refreshIfIdle);

    // The page's DOM changes: find the annotated elements again, but not on every mutation.
    if (document.body) {
      new MutationObserver(() => this.#scheduleReanchor()).observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.#draft) this.#cancelDraft();
    });
  }

  /* ------------------------------------------------------------------ settings */

  #restoreSettings(): void {
    void chrome.storage.local
      .get(STORED_KEYS)
      .then((stored) => {
        this.#inbox.unread = typeof stored.unreadCount === "number" ? stored.unreadCount : 0;
        this.#bubblesOpen = stored.bubblesOpen === true;
        this.#captures.restore(stored);
        this.#mover.restore(stored);
        this.#render();
      })
      .catch(() => undefined);
  }

  /** Another tab moved or pinned the panel, or the unread count changed: follow. */
  #followSettings(): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.unreadCount) {
        this.#inbox.unread = typeof changes.unreadCount.newValue === "number" ? changes.unreadCount.newValue : 0;
        if (this.#view === "inbox" && this.#inbox.idle) void this.#inbox.load();
        else this.#render();
      }
      if (this.#mover.follow(changes)) this.#render();
    });
  }

  /** Resized: stay inside the window, and redraw once it settles, since "Made at …px wide" depends on the width. */
  #followWindowSize(): void {
    let resizeTimer = 0;
    window.addEventListener("resize", () => {
      this.#mover.place();
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => this.#render(), RESIZE_REDRAW_MS);
    });
  }

  #flashNote(text: string): void {
    this.#note = text;
    this.#render();
    window.setTimeout(() => {
      if (this.#note !== text) return;
      this.#note = "";
      this.#render();
    }, NOTE_SHOWN_MS);
  }

  #setBubblesOpen(open: boolean): void {
    this.#bubblesOpen = open;
    remember({ bubblesOpen: open });
    this.#render();
  }

  /* ------------------------------------------------------------------ data */

  /** Keeps the panel and bubbles attached, and reloads when a single-page app moves to another address. */
  #followAddress(): void {
    if (this.#overlay.ensureAttached() || !this.#host.isConnected) document.documentElement.append(this.#host);
    this.#bubbles.ensureAttached();
    if (location.href === this.#href) return;
    if (!this.#carry.moved(this.#href, this.#target?.id ?? "", this.#draft !== null)) {
      this.#draft = null;
      this.#scope = { query: false, hash: false };
    }
    this.#href = location.href;
    void this.#load();
  }

  async #load(): Promise<void> {
    try {
      const [pages, pullRequest] = await Promise.all([
        call<LivePage[]>({ type: "live.list", url: location.href }),
        call<PullRequestPage | null>({ type: "live.pullRequest", url: location.href }).catch(() => this.#pullRequest),
      ]);
      this.#setPages(pages);
      this.#pullRequest = pullRequest;
      this.#error = "";
    } catch (e) {
      this.#error = messageOf(e);
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
      this.#error = messageOf(e);
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

  #organizationOf(projectId: string): string | null {
    return this.#projects.get(projectId)?.organizationId ?? null;
  }

  /** A comment's number on the page (its badge), by when it was made. */
  #labelOf(id: string): number {
    return this.#annotations.findIndex((a) => a.id === id) + 1;
  }

  #visible(): PageAnnotation[] {
    return this.#annotations.filter((a) => this.#showResolved || a.status === "Open");
  }

  #syncOverlay(): void {
    const annotations: OverlayAnnotation[] = this.#visible().map((a) => ({
      id: a.id,
      kind: a.kind as AnnotationKind,
      color: a.color,
      resolved: a.status === "Resolved",
      label: this.#labelOf(a.id),
      anchor: a.anchor as Anchor,
      geometry: a.geometry as Geometry,
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

  /** Changes to one comment, for the views' buttons. */
  #actionsFor(a: PageAnnotation): CommentActions {
    const update = (change: { status: "Open" | "Resolved" } | { body: string }) =>
      void this.#mutate(() => call({ type: "live.update", id: a.id, version: a.version, ...change }));
    return {
      setResolved: (resolved) => update({ status: resolved ? "Resolved" : "Open" }),
      remove: () => void this.#mutate(() => call({ type: "live.delete", id: a.id, version: a.version })),
      startEdit: () => {
        this.#editing = { id: a.id, draft: draftOf(a.body, a.people ?? []) };
        this.#render();
      },
      saveEdit: (draft) => {
        this.#editing = null;
        update({ body: draftBody(draft) });
      },
      cancelEdit: () => {
        this.#editing = null;
        this.#render();
      },
    };
  }

  /* ------------------------------------------------------------------ overlay events */

  #onOverlay(message: OverlayMessage): void {
    switch (message.type) {
      case "draft":
        this.#draft = message.draft;
        this.#draftText = EMPTY_DRAFT;
        this.#draftNumber++;
        this.#open = true;
        this.#render(); // a new comment box, focused
        break;
      case "selected":
        this.#selected = message.id;
        this.#open = true;
        this.#render();
        this.#scrollToEntry(message.id ?? "");
        break;
      case "anchors":
        this.#quality = message.quality;
        this.#render();
        break;
      case "marks":
        this.#bubbles.setPositions(message.positions);
        break;
      case "hover":
        this.#bubbles.hover(message.id);
        break;
      case "ready":
        break;
    }
  }

  #scrollToEntry(id: string): void {
    this.#root.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  /* ------------------------------------------------------------------ making comments */

  #setTool(tool: Tool): void {
    this.#tool = tool;
    // While recording, clicks belong to the page: the tool takes effect when it stops.
    if (!this.#recordingTab) this.#overlay.handle({ type: "setTool", tool, color: this.#color });
    this.#render();
  }

  /** The tab is being recorded, or not: while it is, the tool steps aside so clicks don't move the draft. */
  recordingTab(on: boolean): void {
    if (on === this.#recordingTab) return;
    this.#recordingTab = on;
    this.#overlay.handle({ type: "setTool", tool: on ? "select" : this.#tool, color: this.#color });
    // Recording from the bar on the page, the panel gets out of the way until it stops.
    if (this.#captures.recorderOnPage) {
      this.#open = !on;
      this.#render();
    }
  }

  #writing() {
    return { text: this.#draftText, color: this.#color, scope: this.#scope, projectId: this.#target?.id ?? "" };
  }

  #cancelDraft(): void {
    this.#captures.closeRecorder();
    this.#captures.discardRecording();
    this.#carry.clear();
    this.#draft = null;
    this.#draftText = EMPTY_DRAFT;
    this.#overlay.handle({ type: "clearDraft" });
    this.#render();
  }

  async #saveDraft(): Promise<void> {
    const draft = this.#draft;
    const body = draftBody(this.#draftText);
    const target = this.#target;
    if (!draft || !target || this.#busy) return;
    await this.#mutate(async () => {
      const from = this.#carry.from;
      const created = await call<LiveAnnotation>({
        type: "live.create",
        projectId: from?.projectId ?? target.id,
        url: this.#carry.url,
        ...scopeFor(this.#carry.url, this.#scope),
        kind: draft.kind,
        body,
        color: this.#color,
        anchor: draft.anchor,
        geometry: draft.geometry,
        viewportWidth: draft.viewportWidth,
      });
      const note = await this.#captures.attach(created.id, draft, [this.#host, this.#bubbles.host], !from);
      this.#carry.clear();
      if (note) this.#flashNote(note);
      else await this.#load(); // the screenshot and recording are there: show them
      this.#draft = null;
      this.#draftText = EMPTY_DRAFT;
      this.#selected = created.id;
      this.#overlay.handle({ type: "clearDraft" });
      this.#setTool("select");
    });
  }

  async #sharePage(): Promise<void> {
    const target = this.#target;
    if (!target) return;
    try {
      const share = await call<{ url: string; existing: boolean; expiresAt: string | null }>({
        type: "live.share",
        projectId: target.id,
        url: location.href,
      });
      const copied = await copyText(share.url);
      const { url, existing, expiresAt } = share;
      this.#shared = { url, existing, expiresAt, projectName: target.name, copied };
      this.#render();
    } catch (e) {
      this.#flashNote(`Couldn't share: ${messageOf(e)}`);
    }
  }

  /* ------------------------------------------------------------------ views */

  #setView(view: View): void {
    this.#view = view;
    if (view === "inbox") void this.#inbox.load();
    if (view === "activity") this.#activity.open();
    this.#render();
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

  /* ------------------------------------------------------------------ rendering */

  /** Redraws the panel and bubbles. Preact updates what changed, so boxes being typed in keep their text and focus. */
  /** Draws the panel; places it and (unless only it changed, as when typing) the bubbles in the next frame. */
  #render(bubbles = true): void {
    render(this.#draw(), this.#root);
    this.#nextFrame.request(bubbles);
  }

  #draw(): ComponentChild {
    if (!this.#open) {
      return launcher({
        openCount:
          this.#annotations.filter((a) => a.status === "Open").length +
          (this.#pullRequest?.comments.filter((c) => c.status === "Open").length ?? 0),
        unread: this.#inbox.unread,
        pinned: this.#mover.pinned,
        onOpen: () => {
          if (this.#mover.justDragged) return;
          this.#open = true;
          this.#render();
        },
        onDragStart: (e) => this.#mover.startDrag(e),
      });
    }
    return (
      <>
        <div className="panel">
          {this.#panelTop()}
          {this.#viewContent()}
        </div>
        {cornerPin(this.#mover.pinned, () => this.#mover.setPinned(!this.#mover.pinned))}
      </>
    );
  }

  /** The header and any notices under it. */
  #panelTop(): ComponentChild[] {
    return [
      header({
        view: this.#view,
        busy: this.#busy,
        unread: this.#inbox.unread,
        shareProject: this.#init.features.sharing && this.#target ? this.#target.name : null,
        bubblesOpen: this.#bubblesOpen,
        marksVisible: this.#marksVisible,
        pinned: this.#mover.pinned,
        justDragged: () => this.#mover.justDragged,
        onView: (view) => this.#setView(view),
        onShare: () => void this.#sharePage(),
        onBubblesOpen: (open) => this.#setBubblesOpen(open),
        onMarksVisible: (visible) => {
          this.#marksVisible = visible;
          this.#overlay.setVisible(visible);
          this.#render();
        },
        onMinimise: () => {
          this.#open = false;
          this.#render();
        },
        onDragStart: (e) => this.#mover.startDrag(e),
        onResetPosition: () => this.#mover.reset(),
      }),
      this.#size.matched && sizeBar(this.#size.matched, () => void this.#size.restore()),
      this.#shared &&
        sharedBox(this.#shared, () => {
          this.#shared = null;
          this.#render();
        }),
      this.#note && <p className="hint">{this.#note}</p>,
    ];
  }

  #viewContent(): ComponentChild {
    if (this.#view === "inbox") return this.#inbox.parts();
    if (this.#view === "activity") return this.#activity.parts();
    return this.#commentsView();
  }

  /** The Comments tab: tools for a new comment, the draft being written, and the page's comments. */
  #commentsView(): ComponentChild[] {
    return [
      this.#target ? this.#toolbar(this.#target) : cannotComment(this.#init.projects.length > 0),
      this.#draft && this.#carry.from && <p className="hint">On {this.#carry.from.url}: it's saved there.</p>,
      this.#draft && this.#draftBox(),
      this.#error && <p className="error">{this.#error}</p>,
      this.#pullRequest && pullRequestBox(this.#pullRequest, this.#init.serverUrl),
      ...this.#commentList(),
    ];
  }

  #toolbar(target: LiveProject): ComponentChild {
    return toolbar({
      commentable: this.#init.projects.filter((p) => p.canComment),
      target,
      tool: this.#tool,
      color: this.#color,
      drafting: this.#draft !== null,
      onTarget: (projectId) => {
        this.#target = this.#projects.get(projectId) ?? this.#target;
        this.#render();
      },
      onTool: (tool) => this.#setTool(tool),
      onColor: (color) => {
        this.#color = color;
        this.#setTool(this.#tool);
      },
    });
  }

  #draftBox(): ComponentChild {
    const input = draftInput({
      number: this.#draftNumber,
      draft: this.#draftText,
      onChange: (draft) => {
        this.#draftText = draft;
        this.#carry.keepSoon();
        this.#render(false);
      },
      organizationId: () => this.#target?.organizationId ?? null,
      docsOn: this.#init.features.docs,
      onSave: () => void this.#saveDraft(),
      onCancel: () => this.#cancelDraft(),
    });
    return draftBox({
      input,
      scope: scopeChooser(this.#carry.url, scopeFor(this.#carry.url, this.#scope), (scope) => {
        this.#scope = scope;
        this.#render();
      }),
      busy: this.#busy,
      issueTitleHint: this.#init.features.issueTrackers,
      ...this.#captures.options(),
      onSave: () => void this.#saveDraft(),
      onCancel: () => this.#cancelDraft(),
    });
  }

  /** The page's comments, and "Show resolved" when some are hidden. */
  #commentList(): ComponentChild[] {
    const visible = this.#visible();
    const resolvedCount = this.#annotations.filter((a) => a.status !== "Open").length;
    const empty = this.#annotations.length ? "No open comments." : "No comments on this page yet.";
    const list = (
      <ol className="list">
        {visible.map((a) => this.#listEntry(a))}
        {visible.length === 0 && <li className="empty">{empty}</li>}
      </ol>
    );
    if (resolvedCount === 0) return [list];
    const toggle = () => {
      this.#showResolved = !this.#showResolved;
      this.#syncOverlay();
      this.#render();
    };
    return [
      list,
      <button key="resolved" type="button" className="link" onClick={toggle}>
        {this.#showResolved ? "Hide resolved" : `Show resolved (${resolvedCount})`}
      </button>,
    ];
  }

  #listEntry(a: PageAnnotation): ComponentChild {
    const multiProject = new Set(this.#annotations.map((x) => x.projectId)).size > 1;
    const editing = this.#editing?.id === a.id ? this.#editing : null;
    return listEntry(this.#ctx, this.#parts, a, {
      label: this.#labelOf(a.id),
      selected: a.id === this.#selected,
      orphaned: this.#quality[a.id] === "orphaned",
      projectName: multiProject ? (this.#projects.get(a.projectId)?.name ?? "") : null,
      showAddress: location.search.length > 1 || location.hash.length > 1,
      canComment: this.#canCommentIn(a.projectId),
      editing: editing && {
        draft: editing.draft,
        onChange: (draft) => {
          this.#editing = { id: a.id, draft };
          this.#render();
        },
        organizationId: () => this.#organizationOf(a.projectId),
      },
      onSelect: () => {
        this.#selected = a.id;
        this.#overlay.handle({ type: "select", id: a.id, scroll: true });
        this.#render();
      },
      actions: this.#actionsFor(a),
    });
  }
}
