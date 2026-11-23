import outfitLatinUrl from "@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url";
import { api } from "./api";
import { NotSignedInError } from "./auth";
import { bytesToBase64 } from "./base64";
import { HELPER_SETUP_PAGE, helperEnabled, helperOffered, IMPROVE_HINT_HIDDEN, improveDraft } from "./claude-helper";
import type { LiveInit, LiveRequest, PullRequestPage } from "./live-types";
import { inbox, markRead } from "./notifications";
import {
  canRecordHidden,
  canRecordInSidebar,
  clearRecorder,
  isCarriedPage,
  keepDraft,
  recorderState,
  startWindow,
  stopTab,
} from "./recorder-session";
import { discardRecording, uploadRecording } from "./recordings";
import {
  cancelFullPage,
  captureFullPageFrame,
  captureScreenshot,
  finishFullPage,
  screenshotForPage,
  startFullPage,
  uploadResult,
} from "./screenshots";
import { getSettings } from "./settings";
import { SITE_PRODUCTS_KEY, siteProductsFor } from "./site-products";
import { resizeWindow, restoreWindow, windowResized, zoomTab } from "./window-sizing";

export type * from "./live-types";

/**
 * Live mode, background side. Anyone who can comment in a project can annotate any site; Viewers only see comments.
 * <ul>
 * <li>The live content script is registered for every http(s) page, but stays invisible unless the page's site has comments
 * or the user opens it from the toolbar.</li>
 * <li>Privacy: the background keeps a cached list of the sites (origins only) that have comments. A page's full address is
 * only sent to the server on those sites, or when the user asks to comment on that page.</li>
 * <li>All API calls are made here, checked against the sender's real origin, so the access token never enters a web page.</li>
 * </ul>
 */

const SCRIPT_ID = "inklayer-live";
const CAPTURE_SCRIPT_ID = "inklayer-capture";
const ALL_SITES = ["https://*/*", "http://*/*"];
const CACHE_MS = 5 * 60 * 1000;
const ACTIVITY_PAGE_SIZE = 30;
const INBOX_SIZE = 20;
const MAX_PEOPLE_QUERY = 100;
const MAX_DOCS_QUERY = 200;

/* -------------------------------------------------------------- cached lookups */

/** A value fetched at most every CACHE_MS. */
class Cached<T> {
  #entry: { at: number; value: T } | null = null;
  readonly #load: () => Promise<T>;

  constructor(load: () => Promise<T>) {
    this.#load = load;
  }

  async get(): Promise<T> {
    if (!this.#entry || Date.now() - this.#entry.at > CACHE_MS)
      this.#entry = { at: Date.now(), value: await this.#load() };
    return this.#entry.value;
  }

  /** The value if it's loaded, to update in place. */
  peek(): T | null {
    return this.#entry?.value ?? null;
  }

  clear(): void {
    this.#entry = null;
  }
}

/** The sites (origins only) that have comments the user can see. */
const origins = new Cached(async () => new Set(await api.get("/api/live/origins")));
const projects = new Cached(() => api.get("/api/live/projects"));
const features = new Cached(() => api.get("/api/features"));
/** Addresses of pull requests with linked comments: matched here, so other pages' addresses are never sent. */
const pullRequestUrls = new Cached(() => api.get("/api/live/pull-requests"));

/** The linked pull request this page is (or is a tab of, like its files), if any. */
async function pullRequestUrlOf(url: string): Promise<string | null> {
  if (!(await features.get()).issueTrackers) return null;
  return matchPullRequest(url, await pullRequestUrls.get());
}

/** Which of the pull requests `url` is: the address itself, or one of its tabs (`/files`, `?_a=files`, `#…`). */
export function matchPullRequest(url: string, pullRequests: readonly string[]): string | null {
  return pullRequests.find((u) => url === u || ["/", "?", "#"].some((next) => url.startsWith(u + next))) ?? null;
}

/** The comments linked to the pull request this page is; null on other pages. */
async function pullRequestOf(url: string): Promise<PullRequestPage | null> {
  const match = await pullRequestUrlOf(url);
  if (!match) return null;
  try {
    return await api.get("/api/live/pull-request", { params: { query: { url: match } } });
  } catch {
    return null;
  }
}

async function signedIn(): Promise<boolean> {
  const { serverUrl, tokens } = await getSettings();
  return Boolean(serverUrl && tokens);
}

/* -------------------------------------------------------------- the content scripts */

/** Registers the live script for every site (if the user granted site access), or unregisters it when signed out. */
export async function syncLiveScript(): Promise<void> {
  const allowed = (await signedIn()) && (await chrome.permissions.contains({ origins: ALL_SITES }));
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID, CAPTURE_SCRIPT_ID] });
  const existing = registered.map((s) => s.id);
  if (!allowed) {
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: existing });
    return;
  }
  const missing: chrome.scripting.RegisteredContentScript[] = [];
  if (!existing.includes(SCRIPT_ID)) {
    missing.push({
      id: SCRIPT_ID,
      matches: ALL_SITES,
      js: ["live.js"],
      runAt: "document_idle",
      allFrames: false,
      persistAcrossSessions: true,
    });
  }
  // Keeps the page's last few console errors and failed requests, in the page, for bug reports (capture-main.ts).
  if (!existing.includes(CAPTURE_SCRIPT_ID)) {
    missing.push({
      id: CAPTURE_SCRIPT_ID,
      matches: ALL_SITES,
      js: ["capture.js"],
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
      world: "MAIN",
    });
  }
  if (missing.length > 0) await chrome.scripting.registerContentScripts(missing);
}

export async function stopLive(): Promise<void> {
  origins.clear();
  projects.clear();
  features.clear();
  pullRequestUrls.clear();
  await syncLiveScript();
}

/** Opens the live panel in a tab, injecting the script first if the page loaded before it was registered. */
export async function openLiveInTab(tabId: number, view: "comments" | "activity" = "comments"): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["live.js"] }); // a no-op if it's already there
  await chrome.tabs.sendMessage(tabId, { type: "inklayer.live.open", view });
}

/* -------------------------------------------------------------- requests from the content script */

/** The page a request came from: its real origin (never one the page claims), and its window and tab. */
export interface Sender {
  origin: string;
  windowId?: number;
  tabId?: number;
}

type Handler<K extends LiveRequest["type"]> = (
  request: Extract<LiveRequest, { type: K }>,
  sender: Sender,
) => Promise<unknown>;

/** One handler per request type; the compiler checks none is missing. */
type Handlers = { [K in LiveRequest["type"]]: Handler<K> };

export const isLiveRequest = (request: { type?: unknown }): request is LiveRequest =>
  typeof request.type === "string" && request.type.startsWith("live.");

/** Handles a request from the live content script, after checking it's about the page that sent it. */
export async function handleLive(
  request: LiveRequest,
  senderUrl: string | undefined,
  senderWindowId?: number,
  senderTabId?: number,
): Promise<unknown> {
  const origin = senderUrl ? safeOrigin(senderUrl) : null;
  if (!origin) throw new Error("Unknown page.");
  if ("url" in request && safeOrigin(request.url) !== origin && !(await carriedElsewhere(request, senderTabId)))
    throw new Error("Wrong page.");
  const handler = HANDLERS[request.type] as Handler<typeof request.type>;
  return handler(request as never, { origin, windowId: senderWindowId, tabId: senderTabId });
}

/**
 * A comment carried across pages with its recording is saved on the page it was started on, which may be on another
 * site than the page the tab is on now: allowed only for that page, which the extension kept itself.
 */
async function carriedElsewhere(request: LiveRequest, tabId: number | undefined): Promise<boolean> {
  return request.type === "live.create" && tabId !== undefined && (await isCarriedPage(tabId, request.url));
}

function windowOf(sender: Sender): number {
  if (sender.windowId === undefined) throw new Error("Unknown window.");
  return sender.windowId;
}

function tabOf(sender: Sender): number {
  if (sender.tabId === undefined) throw new Error("Unknown tab.");
  return sender.tabId;
}

/** Lookups are limited to organisations the user has projects in, so a page can't make the extension probe others. */
async function checkOrganization(orgId: string): Promise<void> {
  if (!(await projects.get()).some((p) => p.organizationId === orgId)) throw new Error("Unknown organisation.");
}

const HANDLERS: Handlers = {
  // Automatic, on every page load: stay quiet unless this site has comments. Only the origin is checked here.
  // Pull requests with linked comments count too, though their site may have no comments of its own.
  "live.check": async (r, { origin }) => {
    if (!(await signedIn())) return null;
    if (!(await origins.get()).has(origin) && !(await pullRequestUrlOf(r.url))) return null;
    return init(r.url);
  },
  // The user asked to comment on this page.
  "live.open": async (r) => {
    if (!(await signedIn())) throw new NotSignedInError();
    return init(r.url);
  },
  "live.list": (r) => pageComments(r.url),
  "live.pullRequest": (r) => pullRequestOf(r.url),

  /* ---------------- comments */
  "live.create": async (r, { origin }) => {
    const { type: _type, projectId, ...body } = r;
    const created = await api.post("/api/projects/{projectId}/live/annotations", {
      params: { path: { projectId } },
      body,
    });
    origins.peek()?.add(safeOrigin(r.url) ?? origin);
    await chrome.storage.local.set({ lastLiveProjectId: projectId });
    return created;
  },
  "live.update": ({ id, version, status, body }) =>
    api.patch("/api/annotations/{annotationId}", {
      params: { path: { annotationId: id } },
      body: { version, status, body },
    }),
  "live.delete": async (r) => {
    await api.delete("/api/annotations/{annotationId}", {
      params: { path: { annotationId: r.id }, query: { version: r.version } },
    });
    return null;
  },
  "live.reply": (r) =>
    api.post("/api/annotations/{annotationId}/replies", {
      params: { path: { annotationId: r.annotationId } },
      body: { body: r.body },
    }),
  "live.replyDelete": async (r) => {
    await api.delete("/api/replies/{replyId}", { params: { path: { replyId: r.id }, query: { version: r.version } } });
    return null;
  },

  /* ---------------- bug context */
  // The tab's zoom, which the page itself can't read, so the page can be seen as the commenter saw it.
  "live.context": async (r, { tabId }) => {
    const zoom = tabId === undefined ? null : await chrome.tabs.getZoom(tabId).catch(() => null);
    await api.put("/api/annotations/{annotationId}/context", {
      params: { path: { annotationId: r.annotationId } },
      body: { ...r.context, zoom },
    });
    return null;
  },
  "live.capture": async (r, sender) => {
    await captureScreenshot(windowOf(sender), r.annotationId, r.area, r.viewportWidth);
    return null;
  },
  // The page waits for this after showing the panel again, to say if the upload failed.
  "live.captureResult": async (r) => {
    await uploadResult(r.annotationId);
    return null;
  },
  "live.screenshot": (r) => screenshotForPage(r.annotationId),
  // A full-page screenshot: the page scrolls through itself, and each screen is taken here.
  "live.fullPageStart": async (r) => startFullPage(r.annotationId, r.width, r.height),
  "live.fullPageFrame": async (r, sender) => {
    await captureFullPageFrame(windowOf(sender), r.annotationId, r.y);
    return null;
  },
  "live.fullPageEnd": async (r) => {
    await finishFullPage(r.annotationId);
    return null;
  },
  "live.fullPageCancel": async (r) => {
    cancelFullPage(r.annotationId);
    return null;
  },
  // A recording of the tab, made outside the page so it carries on across page changes (see recorder-session.ts): kept
  // until the comment is saved, then uploaded with it. It starts from the bar on the page: Chrome records hidden,
  // Firefox in Inklayer's sidebar. Elsewhere, a small window.
  "live.recordStart": async (_, sender) => {
    if (canRecordHidden() || canRecordInSidebar()) return "bar";
    await startWindow(tabOf(sender));
    return "window";
  },
  "live.recordInWindow": async (_, sender) => {
    await startWindow(tabOf(sender));
    return null;
  },
  "live.recorder": (_, sender) => recorderState(tabOf(sender)),
  "live.recorderDraft": async (r, sender) => {
    await keepDraft(tabOf(sender), r.draft);
    return null;
  },
  "live.recorderStop": async (_, sender) => {
    await stopTab(tabOf(sender));
    return null;
  },
  "live.recorderClear": async (_, sender) => {
    await clearRecorder(tabOf(sender));
    return null;
  },
  "live.recordingUpload": async (r) => {
    await uploadRecording(r.annotationId, r.recordingId);
    return null;
  },
  "live.recordingDiscard": async (r) => {
    await discardRecording(r.recordingId);
    return null;
  },

  /* ---------------- issues and sharing */
  // Only the user's own projects, so a page can't make the extension probe others.
  "live.trackers": async (r) => {
    if (!(await projects.get()).some((p) => p.id === r.projectId)) throw new Error("Unknown project.");
    return api.get("/api/projects/{projectId}/issue-trackers/choices", {
      params: { path: { projectId: r.projectId } },
    });
  },
  "live.issue": (r) =>
    api.post("/api/annotations/{annotationId}/issues", {
      params: { path: { annotationId: r.annotationId } },
      body: {
        connectionId: r.connectionId,
        parent: r.parent?.slice(0, 2000) || undefined,
        type: r.issueType?.slice(0, 200) || undefined,
      },
    }),
  // The types the user can create issues as (Jira, Azure DevOps); only in their own projects, like searching.
  "live.issueTypes": async (r) => {
    if (!(await projects.get()).some((p) => p.id === r.projectId)) throw new Error("Unknown project.");
    return api.get("/api/projects/{projectId}/issue-trackers/{id}/issue-types", {
      params: { path: { projectId: r.projectId, id: r.connectionId } },
    });
  },
  // Searching is limited to the user's own projects, like the tracker list.
  "live.issueSearch": async (r) => {
    if (!(await projects.get()).some((p) => p.id === r.projectId)) throw new Error("Unknown project.");
    return api.get("/api/projects/{projectId}/issue-trackers/{id}/search", {
      params: {
        path: { projectId: r.projectId, id: r.connectionId },
        query: { q: r.q.slice(0, 2000), pullRequests: r.pullRequests === true },
      },
    });
  },
  "live.issueLink": async (r) => {
    if (r.pullRequest) pullRequestUrls.clear();
    return api.post("/api/annotations/{annotationId}/issues/link", {
      params: { path: { annotationId: r.annotationId } },
      body: {
        connectionId: r.connectionId,
        reference: r.reference.slice(0, 2000),
        addComment: r.addComment,
        pullRequest: r.pullRequest === true,
      },
    });
  },
  // A read-only link to this page's open comments in one project. The page address is the sender's own (checked above).
  "live.share": (r) =>
    api.post("/api/shares", { body: { kind: "page", projectId: r.projectId, pageUrl: r.url, expiresInDays: 30 } }),

  /* ---------------- suggestions */
  "live.people": async (r) => {
    await checkOrganization(r.orgId);
    return api.get("/api/orgs/{orgId}/members/lookup", {
      params: { path: { orgId: r.orgId }, query: { q: r.q.slice(0, MAX_PEOPLE_QUERY) } },
    });
  },
  "live.docs": async (r) => {
    await checkOrganization(r.orgId);
    return api.get("/api/orgs/{orgId}/docs/lookup", {
      params: { path: { orgId: r.orgId }, query: { q: r.q.slice(0, MAX_DOCS_QUERY) } },
    });
  },

  /* ---------------- the window's size and zoom */
  "live.matchSize": (r, sender) => resizeWindow(windowOf(sender), sender.tabId, r),
  "live.restoreSize": (_r, sender) => restoreWindow(windowOf(sender)),
  "live.getZoom": async (_r, sender) => {
    const tabId = tabOf(sender);
    return chrome.tabs.getZoom(tabId);
  },
  "live.setZoom": (r, sender) => zoomTab(windowOf(sender), tabOf(sender), r.zoom),
  "live.sizeSaved": async (_r, { windowId }) => windowId !== undefined && windowResized(windowId),

  /* ---------------- activity, notifications and the panel */
  // "This site" is always the sender's own origin, never a site the page names.
  "live.activity": (r, { origin }) => {
    const query = {
      site: r.thisSite ? origin : undefined,
      kind: r.kind,
      before: r.before,
      limit: ACTIVITY_PAGE_SIZE,
    };
    return api.get("/api/activity", { params: { query } });
  },
  "live.inbox": () => inbox(INBOX_SIZE),
  "live.inboxRead": async (r) => {
    await markRead(r.ids ?? null);
    return null;
  },
  "live.font": () => panelFont(),

  /* ---------------- the local Claude helper: the draft goes to Claude Code on this computer, not the server */
  "live.improve": async ({ url, text, selector, elementText }) => {
    if (!(await signedIn())) throw new NotSignedInError();
    return improveDraft({ url, text, selector, elementText });
  },
  // The comment box's "set up" link: a page can't open the popup, so the setup opens in a tab of its own.
  "live.improveSetup": async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL(HELPER_SETUP_PAGE) });
    return null;
  },
};

/* -------------------------------------------------------------- helpers */

const pageComments = (url: string) => api.get("/api/live/annotations", { params: { query: { url } } });

let panelFontData: Promise<string> | null = null;

/**
 * The theme's body font (Outfit, Latin), base64, for the panel on web pages. Sent as data rather than made a
 * web-accessible resource, so pages can't probe for the extension and their font-src CSP doesn't apply.
 */
function panelFont(): Promise<string> {
  panelFontData ??= fetch(chrome.runtime.getURL(outfitLatinUrl))
    .then((r) => r.arrayBuffer())
    .then((buffer) => bytesToBase64(new Uint8Array(buffer)))
    .catch((error: unknown) => {
      panelFontData = null;
      throw error;
    });
  return panelFontData;
}

/** Everything the panel needs to start on a page: the user's projects, the page's comments, and settings. */
async function init(url: string): Promise<LiveInit> {
  const [all, pages, stored, settings, on, pullRequest, claudeImprove] = await Promise.all([
    projects.get(),
    pageComments(url),
    chrome.storage.local.get(["lastLiveProjectId", SITE_PRODUCTS_KEY, IMPROVE_HINT_HIDDEN]),
    getSettings(),
    features.get(),
    pullRequestOf(url),
    helperEnabled(),
  ]);
  const last = stored.lastLiveProjectId as string | undefined;
  return {
    projects: all,
    pages,
    lastProjectId: last && all.some((p) => p.id === last && p.canComment) ? last : null,
    siteProjectIds: siteProductsFor(stored[SITE_PRODUCTS_KEY], safeOrigin(url), all),
    serverUrl: new URL(settings.serverUrl ?? "").origin,
    features: on,
    pullRequest,
    claudeImprove,
    claudeImproveHint: !claudeImprove && helperOffered() && stored[IMPROVE_HINT_HIDDEN] !== true,
  };
}

/** The origin of an http(s) address; null for anything else (or nonsense). */
export function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** Every request type the background handles, for tests that check the content script only sends these. */
export const HANDLED_REQUEST_TYPES = Object.keys(HANDLERS) as LiveRequest["type"][];
