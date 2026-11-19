import outfitLatinUrl from "@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url";
import { api, type Features, postJson, putJson } from "./api";
import { NotSignedInError } from "./auth";
import { bytesToBase64 } from "./base64";
import type {
  ActivityPage,
  DocLookup,
  LinkedIssue,
  LiveAnnotation,
  LiveInit,
  LivePage,
  LiveProject,
  LiveReply,
  LiveRequest,
  PersonLookup,
  TrackerChoice,
} from "./live-types";
import { inbox, markRead } from "./notifications";
import { captureScreenshot, screenshotForPage, uploadResult } from "./screenshots";
import { getSettings } from "./settings";
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
const ACTIVITY_PAGE_SIZE = "30";
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
const origins = new Cached(async () => new Set(await api<string[]>("/api/live/origins")));
const projects = new Cached(() => api<LiveProject[]>("/api/live/projects"));
const features = new Cached(() => api<Features>("/api/features"));

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
  if ("url" in request && safeOrigin(request.url) !== origin) throw new Error("Wrong page.");
  const handler = HANDLERS[request.type] as Handler<typeof request.type>;
  return handler(request as never, { origin, windowId: senderWindowId, tabId: senderTabId });
}

function windowOf(sender: Sender): number {
  if (sender.windowId === undefined) throw new Error("Unknown window.");
  return sender.windowId;
}

function tabOf(sender: Sender): number {
  if (sender.tabId === undefined) throw new Error("Unknown tab.");
  return sender.tabId;
}

const enc = encodeURIComponent;

/** Lookups are limited to organisations the user has projects in, so a page can't make the extension probe others. */
async function checkOrganization(orgId: string): Promise<void> {
  if (!(await projects.get()).some((p) => p.organizationId === orgId)) throw new Error("Unknown organisation.");
}

const HANDLERS: Handlers = {
  // Automatic, on every page load: stay quiet unless this site has comments. Only the origin is checked here.
  "live.check": async (r, { origin }) => {
    if (!(await signedIn()) || !(await origins.get()).has(origin)) return null;
    return init(r.url);
  },
  // The user asked to comment on this page.
  "live.open": async (r) => {
    if (!(await signedIn())) throw new NotSignedInError();
    return init(r.url);
  },
  "live.list": (r) => api<LivePage[]>(`/api/live/annotations?url=${enc(r.url)}`),

  /* ---------------- comments */
  "live.create": async (r, { origin }) => {
    const { type: _type, projectId, ...body } = r;
    const created = await postJson<LiveAnnotation>(`/api/projects/${enc(projectId)}/live/annotations`, body);
    origins.peek()?.add(origin);
    await chrome.storage.local.set({ lastLiveProjectId: projectId });
    return created;
  },
  "live.update": ({ id, version, status, body }) =>
    api<LiveAnnotation>(`/api/annotations/${enc(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version, status, body }),
    }),
  "live.delete": (r) => api<null>(`/api/annotations/${enc(r.id)}?version=${r.version}`, { method: "DELETE" }),
  "live.reply": (r) => postJson<LiveReply>(`/api/annotations/${enc(r.annotationId)}/replies`, { body: r.body }),
  "live.replyDelete": (r) => api<null>(`/api/replies/${enc(r.id)}?version=${r.version}`, { method: "DELETE" }),

  /* ---------------- bug context */
  // The tab's zoom, which the page itself can't read, so the page can be seen as the commenter saw it.
  "live.context": async (r, { tabId }) => {
    const zoom = tabId === undefined ? null : await chrome.tabs.getZoom(tabId).catch(() => null);
    return putJson<null>(`/api/annotations/${enc(r.annotationId)}/context`, { ...r.context, zoom });
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

  /* ---------------- issues and sharing */
  // Only the user's own projects, so a page can't make the extension probe others.
  "live.trackers": async (r) => {
    if (!(await projects.get()).some((p) => p.id === r.projectId)) throw new Error("Unknown project.");
    return api<TrackerChoice[]>(`/api/projects/${enc(r.projectId)}/issue-trackers/choices`);
  },
  "live.issue": (r) =>
    postJson<LinkedIssue>(`/api/annotations/${enc(r.annotationId)}/issues`, { connectionId: r.connectionId }),
  // A read-only link to this page's open comments in one project. The page address is the sender's own (checked above).
  "live.share": (r) =>
    postJson<{ url: string }>("/api/shares", {
      kind: "page",
      projectId: r.projectId,
      pageUrl: r.url,
      expiresInDays: 30,
    }),

  /* ---------------- suggestions */
  "live.people": async (r) => {
    await checkOrganization(r.orgId);
    const q = enc(r.q.slice(0, MAX_PEOPLE_QUERY));
    return api<PersonLookup[]>(`/api/orgs/${enc(r.orgId)}/members/lookup?q=${q}`);
  },
  "live.docs": async (r) => {
    await checkOrganization(r.orgId);
    const q = enc(r.q.slice(0, MAX_DOCS_QUERY));
    return api<DocLookup[]>(`/api/orgs/${enc(r.orgId)}/docs/lookup?q=${q}`);
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
    const query = new URLSearchParams();
    if (r.thisSite) query.set("site", origin);
    if (r.kind) query.set("kind", r.kind);
    if (r.before) query.set("before", r.before);
    query.set("limit", ACTIVITY_PAGE_SIZE);
    return api<ActivityPage>(`/api/activity?${query}`);
  },
  "live.inbox": () => inbox(INBOX_SIZE),
  "live.inboxRead": async (r) => {
    await markRead(r.ids ?? null);
    return null;
  },
  "live.font": () => panelFont(),
};

/* -------------------------------------------------------------- helpers */

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
  const [all, pages, stored, settings, on] = await Promise.all([
    projects.get(),
    api<LivePage[]>(`/api/live/annotations?url=${enc(url)}`),
    chrome.storage.local.get("lastLiveProjectId"),
    getSettings(),
    features.get(),
  ]);
  const last = stored.lastLiveProjectId as string | undefined;
  return {
    projects: all,
    pages,
    lastProjectId: last && all.some((p) => p.id === last && p.canComment) ? last : null,
    serverUrl: new URL(settings.serverUrl ?? "").origin,
    features: on,
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
