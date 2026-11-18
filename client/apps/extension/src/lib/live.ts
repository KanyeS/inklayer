import outfitLatinUrl from "@fontsource-variable/outfit/files/outfit-latin-wght-normal.woff2?url";
import { NotSignedInError } from "./auth";
import { api, postJson, type Features } from "./api";
import type { Person } from "./people";
import { getSettings } from "./settings";

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
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (!allowed) {
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  if (existing.length === 0) {
    await chrome.scripting.registerContentScripts([
      { id: SCRIPT_ID, matches: ALL_SITES, js: ["live.js"], runAt: "document_idle", allFrames: false, persistAcrossSessions: true },
    ]);
  }
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
  | { type: "live.reply"; annotationId: string; body: string }
  | { type: "live.replyDelete"; id: string; version: number };

export const isLiveRequest = (request: { type?: unknown }): request is LiveRequest =>
  typeof request.type === "string" && request.type.startsWith("live.");

export async function handleLive(request: LiveRequest, senderUrl: string | undefined): Promise<unknown> {
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
    case "live.reply":
      return postJson<LiveReply>(`/api/annotations/${encodeURIComponent(request.annotationId)}/replies`, { body: request.body });
    case "live.replyDelete":
      return api<null>(`/api/replies/${encodeURIComponent(request.id)}?version=${request.version}`, { method: "DELETE" });
    case "live.docs": {
      // Only organisations the user has projects in, so a page can't make the extension probe others.
      if (!(await getProjects()).some((p) => p.organizationId === request.orgId)) throw new Error("Unknown organisation.");
      return api<DocLookup[]>(`/api/orgs/${encodeURIComponent(request.orgId)}/docs/lookup?q=${encodeURIComponent(request.q.slice(0, 200))}`);
    }
  }
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
