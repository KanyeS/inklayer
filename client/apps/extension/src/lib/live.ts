import outfitLatinUrl from "@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url";
import { NotSignedInError } from "./auth";
import { api, apiBytes, postJson, putJson, type Features } from "./api";
import type { Rect } from "./pageDetails";
import type { Person } from "./people";
import { getSettings } from "./settings";
import { inbox, markRead } from "./notifications";

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

export interface LiveProject {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  myRole: string;
  canComment: boolean;
}

export interface LiveAnnotation {
  id: string;
  pageUrl: string | null;
  kind: string;
  status: "Open" | "Resolved";
  body: string;
  color: string;
  anchor: unknown;
  geometry: unknown;
  version: number;
  author: Person;
  createdAt: string;
  canEdit: boolean;
  canDelete: boolean;
  organizationId: string;
  /** The [[doc]] links in the body, with the doc each one opens (null if it doesn't exist yet). */
  docLinks?: { text: string; docId: string | null; title: string | null }[];
  /** Docs that link this comment. */
  mentionedIn?: { docId: string; title: string }[];
  /** The thread, oldest first. */
  replies?: LiveReply[];
  /** Page details captured with the comment, if the commenter attached them. */
  context?: PageContext | null;
  hasScreenshot?: boolean;
  /** People @mentioned in the comment or its replies, for showing <@id> as names. */
  people?: PersonLookup[];
  /** The commenter's window width when they commented (CSS pixels). */
  viewportWidth?: number;
  /** Issues created from this comment in GitHub, Jira or Linear. */
  issues?: LinkedIssue[];
}

export interface LinkedIssue {
  id: string;
  kind: "github" | "jira" | "linear";
  key: string;
  url: string;
  state: "open" | "closed";
}

/** An issue tracker connected to a project, to create issues in. */
export interface TrackerChoice {
  id: string;
  kind: LinkedIssue["kind"];
  name: string;
}

export interface LiveReply {
  id: string;
  body: string;
  author: Person;
  createdAt: string;
  updatedAt: string;
  version: number;
  canEdit: boolean;
  canDelete: boolean;
}

/** Someone suggested while typing @, or mentioned in a comment. */
export interface PersonLookup {
  id: string;
  displayName: string;
  fullName: string;
}

/** A doc suggested while typing [[ in a comment. */
export interface DocLookup {
  id: string;
  folder: string;
  title: string;
}

/** One project's comments on the page. */
export interface LivePage {
  projectId: string;
  pageUrl: string;
  annotations: LiveAnnotation[];
}

export interface ActivityItem {
  id: string;
  kind: "comments" | "docs" | "signins" | "errors";
  action: string;
  occurredAt: string;
  actor: (Person & { email: string | null }) | null;
  projectId: string | null;
  projectName: string | null;
  pageUrl: string | null;
  annotationId: string | null;
  detail: string | null;
  docId?: string | null;
  docTitle?: string | null;
  organizationId?: string | null;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** The kinds this user may see: comments for everyone, signins for admins, errors for instance admins. */
  kinds: ActivityItem["kind"][];
  nextBefore: string | null;
}

export interface LiveInit {
  projects: LiveProject[];
  pages: LivePage[];
  /** The project new comments went into last time, if the user can still comment there. */
  lastProjectId: string | null;
  /** The Inklayer server, for links to docs and comments. */
  serverUrl: string;
  /** Which major features are on for this server. */
  features: Features;
}

const SCRIPT_ID = "inklayer-live";
const CAPTURE_SCRIPT_ID = "inklayer-capture";
const ALL_SITES = ["https://*/*", "http://*/*"];
const CACHE_MS = 5 * 60 * 1000;

let origins: { at: number; value: Set<string> } | null = null;
let projects: { at: number; value: LiveProject[] } | null = null;
let features: { at: number; value: Features } | null = null;

async function getFeatures(): Promise<Features> {
  if (!features || Date.now() - features.at > CACHE_MS) features = { at: Date.now(), value: await api<Features>("/api/features") };
  return features.value;
}

/** Registers the live script for every site (if the user granted site access), or unregisters it when signed out. */
export async function syncLiveScript(): Promise<void> {
  const { serverUrl, tokens } = await getSettings();
  const allowed = Boolean(serverUrl && tokens) && await chrome.permissions.contains({ origins: ALL_SITES });
  const existing = (await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID, CAPTURE_SCRIPT_ID] })).map((s) => s.id);
  if (!allowed) {
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: existing });
    return;
  }
  const missing: chrome.scripting.RegisteredContentScript[] = [];
  if (!existing.includes(SCRIPT_ID)) {
    missing.push({ id: SCRIPT_ID, matches: ALL_SITES, js: ["live.js"], runAt: "document_idle", allFrames: false, persistAcrossSessions: true });
  }
  // Keeps the page's last few console errors and failed requests, in the page, for bug reports (capture-main.ts).
  if (!existing.includes(CAPTURE_SCRIPT_ID)) {
    missing.push({ id: CAPTURE_SCRIPT_ID, matches: ALL_SITES, js: ["capture.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true, world: "MAIN" });
  }
  if (missing.length > 0) await chrome.scripting.registerContentScripts(missing);
}

export async function stopLive(): Promise<void> {
  origins = null;
  projects = null;
  features = null;
  await syncLiveScript();
}

/** Opens the live panel in a tab, injecting the script first if the page loaded before it was registered. */
export async function openLiveInTab(tabId: number, view: "comments" | "activity" = "comments"): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["live.js"] }); // a no-op if it's already there
  await chrome.tabs.sendMessage(tabId, { type: "inklayer.live.open", view });
}

async function getOrigins(): Promise<Set<string>> {
  if (!origins || Date.now() - origins.at > CACHE_MS) origins = { at: Date.now(), value: new Set(await api<string[]>("/api/live/origins")) };
  return origins.value;
}

async function getProjects(): Promise<LiveProject[]> {
  if (!projects || Date.now() - projects.at > CACHE_MS) projects = { at: Date.now(), value: await api<LiveProject[]>("/api/live/projects") };
  return projects.value;
}

async function signedIn(): Promise<boolean> {
  const { serverUrl, tokens } = await getSettings();
  return Boolean(serverUrl && tokens);
}

/* -------------------------------------------------------------- requests from the content script */

/** Messages from the live content script. The background checks each one against the sender's actual origin. */
export type LiveRequest =
  | { type: "live.check"; url: string }
  | { type: "live.open"; url: string }
  | { type: "live.list"; url: string }
  | { type: "live.create"; projectId: string; url: string; kind: string; body: string; color: string; anchor: unknown; geometry: unknown; viewportWidth: number;
      includeQuery: boolean; includeHash: boolean }
  | { type: "live.update"; id: string; version: number; status?: "Open" | "Resolved"; body?: string }
  | { type: "live.delete"; id: string; version: number }
  | { type: "live.activity"; thisSite: boolean; kind?: ActivityItem["kind"]; before?: string }
  | { type: "live.font" }
  | { type: "live.docs"; orgId: string; q: string }
  | { type: "live.people"; orgId: string; q: string }
  | { type: "live.context"; annotationId: string; context: PageContext }
  | { type: "live.capture"; annotationId: string; area: Rect; viewportWidth: number }
  | { type: "live.captureResult"; annotationId: string }
  | { type: "live.screenshot"; annotationId: string }
  | { type: "live.reply"; annotationId: string; body: string }
  | { type: "live.replyDelete"; id: string; version: number }
  | { type: "live.trackers"; projectId: string }
  | { type: "live.issue"; annotationId: string; connectionId: string }
  | { type: "live.share"; projectId: string; url: string }
  | { type: "live.matchSize"; width: number; height?: number; left?: number; top?: number }
  | { type: "live.restoreSize" }
  | { type: "live.getZoom" }
  | { type: "live.setZoom"; zoom: number }
  | { type: "live.sizeSaved" }
  | { type: "live.inbox" }
  | { type: "live.inboxRead"; ids?: string[] };

export const isLiveRequest = (request: { type?: unknown }): request is LiveRequest =>
  typeof request.type === "string" && request.type.startsWith("live.");

export async function handleLive(request: LiveRequest, senderUrl: string | undefined, senderWindowId?: number, senderTabId?: number): Promise<unknown> {
  const senderOrigin = senderUrl ? safeOrigin(senderUrl) : null;
  if (!senderOrigin) throw new Error("Unknown page.");
  if ("url" in request && safeOrigin(request.url) !== senderOrigin) throw new Error("Wrong page.");

  switch (request.type) {
    case "live.check":
      // Automatic, on every page load: stay quiet unless this site has comments. Only the origin is checked here.
      if (!(await signedIn())) return null;
      if (!(await getOrigins()).has(senderOrigin)) return null;
      return init(request.url);
    case "live.open":
      // The user asked to comment on this page.
      if (!(await signedIn())) throw new NotSignedInError();
      return init(request.url);
    case "live.list":
      return api<LivePage[]>(`/api/live/annotations?url=${encodeURIComponent(request.url)}`);
    case "live.create": {
      const { type: _type, projectId, ...body } = request;
      const created = await postJson<LiveAnnotation>(`/api/projects/${encodeURIComponent(projectId)}/live/annotations`, body);
      origins?.value.add(senderOrigin);
      await chrome.storage.local.set({ lastLiveProjectId: projectId });
      return created;
    }
    case "live.update": {
      const { id, version, status, body } = request;
      return api<LiveAnnotation>(`/api/annotations/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version, status, body }),
      });
    }
    case "live.delete":
      return api<null>(`/api/annotations/${encodeURIComponent(request.id)}?version=${request.version}`, { method: "DELETE" });
    case "live.activity": {
      // "This site" is always the sender's own origin, never a site the page names.
      const query = new URLSearchParams();
      if (request.thisSite) query.set("site", senderOrigin);
      if (request.kind) query.set("kind", request.kind);
      if (request.before) query.set("before", request.before);
      query.set("limit", "30");
      return api<ActivityPage>(`/api/activity?${query}`);
    }
    case "live.font":
      return panelFont();
    case "live.context": {
      // The tab's zoom, which the page itself can't read, so the page can be seen as the commenter saw it.
      const zoom = senderTabId === undefined ? null : await chrome.tabs.getZoom(senderTabId).catch(() => null);
      return putJson<null>(`/api/annotations/${encodeURIComponent(request.annotationId)}/context`, { ...request.context, zoom });
    }
    case "live.capture":
      // Taken now, while the page shows the comment; cropped and uploaded in the background so the panel reappears at once.
      if (senderWindowId === undefined) throw new Error("Unknown window.");
      {
        let shot: string;
        try {
          shot = await chrome.tabs.captureVisibleTab(senderWindowId, { format: "png" });
        } catch (error) {
          // Browsers only allow screenshots with access to all sites (or just after the toolbar button is clicked).
          throw /all_urls|activeTab|permission/i.test(String(error))
            ? new Error("Inklayer isn't allowed to take screenshots yet. Click the Inklayer toolbar button, then \"Allow screenshots\".")
            : error;
        }
        const upload = uploadScreenshot(request.annotationId, shot, request.area, request.viewportWidth);
        uploads.set(request.annotationId, upload);
        void upload.catch(() => undefined).finally(() => setTimeout(() => uploads.delete(request.annotationId), 60_000));
      }
      return null;
    case "live.captureResult":
      // The page waits for this after showing the panel again, to say if the upload failed.
      await uploads.get(request.annotationId);
      return null;
    case "live.screenshot": {
      // Sent to the page as base64: the panel draws it on a canvas, which the page's content policy can't block.
      const image = await apiBytes(`/api/annotations/${encodeURIComponent(request.annotationId)}/screenshot`);
      if (!image) return null;
      let binary = "";
      const bytes = new Uint8Array(image.bytes);
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { type: image.type, base64: btoa(binary) };
    }
    case "live.reply":
      return postJson<LiveReply>(`/api/annotations/${encodeURIComponent(request.annotationId)}/replies`, { body: request.body });
    case "live.replyDelete":
      return api<null>(`/api/replies/${encodeURIComponent(request.id)}?version=${request.version}`, { method: "DELETE" });
    case "live.trackers":
      // Only the user's own projects, so a page can't make the extension probe others.
      if (!(await getProjects()).some((p) => p.id === request.projectId)) throw new Error("Unknown project.");
      return api<TrackerChoice[]>(`/api/projects/${encodeURIComponent(request.projectId)}/issue-trackers/choices`);
    case "live.issue":
      return postJson<LinkedIssue>(`/api/annotations/${encodeURIComponent(request.annotationId)}/issues`, { connectionId: request.connectionId });
    case "live.matchSize": {
      // The page's window: remember how it was (once), then resize it. Maximised windows have to become normal to resize.
      if (senderWindowId === undefined) throw new Error("Unknown window.");
      await rememberSize(senderWindowId, senderTabId);
      // Out of maximised first, and wait: some window managers (Linux especially) restore the old size after the change,
      // which would undo a size given in the same step.
      if ((await chrome.windows.get(senderWindowId)).state !== "normal") {
        await chrome.windows.update(senderWindowId, { state: "normal" });
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const { width, height, left, top } = request;
      const updated = await chrome.windows.update(senderWindowId, {
        width, ...(height ? { height } : {}), ...(left !== undefined ? { left } : {}), ...(top !== undefined ? { top } : {}),
      });
      return { width: updated.width ?? width, height: updated.height ?? height ?? 0 };
    }
    case "live.restoreSize": {
      if (senderWindowId === undefined) throw new Error("Unknown window.");
      const saved = await savedSizes();
      const was = saved[senderWindowId];
      if (!was) return false;
      delete saved[senderWindowId];
      await chrome.storage.session.set({ [SAVED_SIZES]: saved });
      if (was.zoomTabId !== undefined && was.zoom) await chrome.tabs.setZoom(was.zoomTabId, was.zoom).catch(() => undefined);
      if (was.state === "maximized" || was.state === "fullscreen") await chrome.windows.update(senderWindowId, { state: was.state });
      else await chrome.windows.update(senderWindowId, { state: "normal", left: was.left, top: was.top, width: was.width, height: was.height });
      return true;
    }
    case "live.getZoom":
      if (senderTabId === undefined) throw new Error("Unknown tab.");
      return chrome.tabs.getZoom(senderTabId);
    case "live.setZoom":
      if (senderTabId === undefined || senderWindowId === undefined) throw new Error("Unknown tab.");
      await rememberSize(senderWindowId, senderTabId);
      await chrome.tabs.setZoom(senderTabId, Math.min(5, Math.max(0.25, request.zoom)));
      return chrome.tabs.getZoom(senderTabId);
    case "live.sizeSaved":
      return senderWindowId !== undefined && Boolean((await savedSizes())[senderWindowId]);
    case "live.inbox":
      return inbox(20);
    case "live.inboxRead":
      await markRead(request.ids ?? null);
      return null;
    case "live.share":
      // A read-only link to this page's open comments in one project. The page address is the sender's own (checked above).
      return postJson<{ url: string }>("/api/shares", { kind: "page", projectId: request.projectId, pageUrl: request.url, expiresInDays: 30 });
    case "live.people": {
      // Only organisations the user has projects in.
      if (!(await getProjects()).some((p) => p.organizationId === request.orgId)) throw new Error("Unknown organisation.");
      return api<PersonLookup[]>(`/api/orgs/${encodeURIComponent(request.orgId)}/members/lookup?q=${encodeURIComponent(request.q.slice(0, 100))}`);
    }
    case "live.docs": {
      // Only organisations the user has projects in, so a page can't make the extension probe others.
      if (!(await getProjects()).some((p) => p.organizationId === request.orgId)) throw new Error("Unknown organisation.");
      return api<DocLookup[]>(`/api/orgs/${encodeURIComponent(request.orgId)}/docs/lookup?q=${encodeURIComponent(request.q.slice(0, 200))}`);
    }
  }
}

const SAVED_SIZES = "savedWindowSizes";

type SavedSize = {
  left?: number; top?: number; width?: number; height?: number; state?: `${chrome.windows.WindowState}`;
  /** The tab whose zoom was changed, and its zoom before. */
  zoomTabId?: number; zoom?: number;
};

/** Notes how a window (and the tab's zoom) was before the first change, for "Back to my size". */
async function rememberSize(windowId: number, tabId: number | undefined): Promise<void> {
  const saved = await savedSizes();
  if (saved[windowId]) return;
  const w = await chrome.windows.get(windowId);
  const zoom = tabId === undefined ? undefined : await chrome.tabs.getZoom(tabId).catch(() => undefined);
  saved[windowId] = { left: w.left, top: w.top, width: w.width, height: w.height, state: w.state, zoomTabId: tabId, zoom };
  await chrome.storage.session.set({ [SAVED_SIZES]: saved });
}

/** Windows resized to a commenter's size, with how they were before (for "Back to my size"). */
async function savedSizes(): Promise<Record<number, SavedSize>> {
  return ((await chrome.storage.session.get(SAVED_SIZES))[SAVED_SIZES] as Record<number, SavedSize> | undefined) ?? {};
}

/** What the page looked like when a comment was made: see capture-main.ts and pageDetails.ts. */
export interface PageContext {
  browser: string;
  os: string;
  userAgent: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  /** The tab's zoom (1 = 100%); added by the background, null for older comments. */
  zoom?: number | null;
  selector: string;
  elementHtml: string;
  console: { level: string; message: string; at: string }[];
  network: { method: string; url: string; status: number; ms: number; at: string }[];
}

const MAX_SCREENSHOT_WIDTH = 1600;
const MAX_SCREENSHOT_BYTES = 600 * 1024;

/** Crops the captured window to the commented area, shrinks it if wide, and uploads it as WebP (JPEG if that's smaller or WebP isn't available). */
/** Screenshot uploads in progress or just finished, by comment. */
const uploads = new Map<string, Promise<void>>();

async function uploadScreenshot(annotationId: string, dataUrl: string, area: Rect, viewportWidth: number): Promise<void> {
  const full = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = full.width / Math.max(1, viewportWidth); // the captured image's pixels per CSS pixel (pixel ratio and zoom)
  const sx = Math.round(area.x * scale);
  const sy = Math.round(area.y * scale);
  const sw = Math.min(full.width - sx, Math.round(area.width * scale));
  const sh = Math.min(full.height - sy, Math.round(area.height * scale));
  const shrink = Math.min(1, MAX_SCREENSHOT_WIDTH / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * shrink), Math.round(sh * shrink));
  canvas.getContext("2d")!.drawImage(full, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  full.close();

  let blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.82 });
  if (blob.type !== "image/webp" || blob.size > MAX_SCREENSHOT_BYTES) blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  if (blob.size > MAX_SCREENSHOT_BYTES) blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.5 });
  if (blob.size > MAX_SCREENSHOT_BYTES) throw new Error("the screenshot was too large to upload.");
  await api<null>(`/api/annotations/${encodeURIComponent(annotationId)}/screenshot?width=${canvas.width}&height=${canvas.height}`, {
    method: "PUT", headers: { "Content-Type": blob.type }, body: blob,
  });
}

let panelFontData: Promise<string> | null = null;

/**
 * The theme's body font (Outfit, Latin), base64, for the panel on web pages. Sent as data rather than made a
 * web-accessible resource, so pages can't probe for the extension and their font-src CSP doesn't apply.
 */
function panelFont(): Promise<string> {
  panelFontData ??= fetch(chrome.runtime.getURL(outfitLatinUrl))
    .then((r) => r.arrayBuffer())
    .then((buffer) => {
      let binary = "";
      for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
      return btoa(binary);
    })
    .catch((error: unknown) => {
      panelFontData = null;
      throw error;
    });
  return panelFontData;
}

async function init(url: string): Promise<LiveInit> {
  const [all, pages, stored, settings, on] = await Promise.all([
    getProjects(),
    api<LivePage[]>(`/api/live/annotations?url=${encodeURIComponent(url)}`),
    chrome.storage.local.get("lastLiveProjectId"),
    getSettings(),
    getFeatures(),
  ]);
  const last = stored.lastLiveProjectId as string | undefined;
  return {
    projects: all, pages, lastProjectId: all.some((p) => p.id === last && p.canComment) ? last! : null,
    serverUrl: new URL(settings.serverUrl!).origin,
    features: on,
  };
}

function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
