import { api, postJson } from "./api";
import { getSettings } from "./settings";

/**
 * Live mode, background side.
 * <ul>
 * <li>Keeps a list of the sites the user's projects review live, from <code>/api/live/sites</code>.</li>
 * <li>Registers the live content script for those sites only. Other pages never load it, and their URLs never leave the browser.</li>
 * <li>Makes API calls on behalf of the content script, so the access token never enters the web page.</li>
 * </ul>
 */

export interface LiveSite {
  projectId: string;
  projectName: string;
  organizationId: string;
  organizationName: string;
  origin: string;
  matchQuery: boolean;
  matchHash: boolean;
  myRole: string;
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
  author: { id: string; displayName: string };
  createdAt: string;
  canEdit: boolean;
  canDelete: boolean;
}

export interface LivePage {
  pageUrl: string;
  annotations: LiveAnnotation[];
}

const SCRIPT_ID = "inklayer-live";
const COMMENT_ROLES = new Set(["Commenter", "Editor", "Admin", "Owner"]);
const STALE_AFTER_MS = 10 * 60 * 1000;

let lastSync = 0;
let syncing: Promise<LiveSite[]> | null = null;

export const canComment = (role: string) => COMMENT_ROLES.has(role);

/** Fetches the live sites and (re)registers the content script for them. Safe to call often; concurrent calls share one sync. */
export function syncLiveSites(): Promise<LiveSite[]> {
  syncing ??= doSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** The cached sites, refreshed in the background when they're older than a few minutes. */
export async function getLiveSites(): Promise<LiveSite[]> {
  if (Date.now() - lastSync > STALE_AFTER_MS) return syncLiveSites();
  const { liveSites } = await chrome.storage.local.get("liveSites");
  return (liveSites as LiveSite[] | undefined) ?? [];
}

export async function stopLive(): Promise<void> {
  await chrome.storage.local.set({ liveSites: [] });
  await setRegistration([]);
}

async function doSync(): Promise<LiveSite[]> {
  const { serverUrl, tokens } = await getSettings();
  if (!serverUrl || !tokens) {
    await stopLive();
    return [];
  }

  let sites: LiveSite[];
  try {
    sites = await api<LiveSite[]>("/api/live/sites");
  } catch {
    // Offline or signed out: keep what we had.
    const { liveSites } = await chrome.storage.local.get("liveSites");
    return (liveSites as LiveSite[] | undefined) ?? [];
  }

  // Never run on the Inklayer server itself.
  const serverOrigin = new URL(serverUrl).origin;
  sites = sites.filter((s) => s.origin !== serverOrigin);
  await chrome.storage.local.set({ liveSites: sites });
  lastSync = Date.now();

  // Match patterns can't carry a port, so this is per host; the content script then asks for its exact origin.
  const patterns = [...new Set(sites.map((s) => {
    const url = new URL(s.origin);
    return `${url.protocol}//${url.hostname}/*`;
  }))];
  const allowed: string[] = [];
  for (const pattern of patterns) {
    if (await chrome.permissions.contains({ origins: [pattern] })) allowed.push(pattern);
  }
  await setRegistration(allowed);
  return sites;
}

async function setRegistration(matches: string[]): Promise<void> {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (matches.length === 0) {
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  const script = { id: SCRIPT_ID, matches, js: ["live.js"], runAt: "document_idle" as const, allFrames: false, persistAcrossSessions: true };
  if (existing.length > 0) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

/* -------------------------------------------------------------- requests from the content script */

/** Messages from the live content script. The background checks each one against the sender's actual origin. */
export type LiveRequest =
  | { type: "live.init"; url: string }
  | { type: "live.list"; projectId: string; url: string }
  | { type: "live.create"; projectId: string; url: string; kind: string; body: string; color: string; anchor: unknown; geometry: unknown; viewportWidth: number }
  | { type: "live.update"; projectId: string; id: string; version: number; status?: "Open" | "Resolved"; body?: string }
  | { type: "live.delete"; projectId: string; id: string; version: number };

export interface LiveInit {
  me: { id: string; displayName: string };
  projects: { id: string; name: string; organizationName: string; myRole: string; canComment: boolean }[];
}

export const isLiveRequest = (request: { type?: unknown }): request is LiveRequest =>
  typeof request.type === "string" && request.type.startsWith("live.");

export async function handleLive(request: LiveRequest, senderUrl: string | undefined): Promise<unknown> {
  const senderOrigin = senderUrl ? safeOrigin(senderUrl) : null;
  if (!senderOrigin) throw new Error("Unknown page.");
  const sites = (await getLiveSites()).filter((s) => s.origin === senderOrigin);

  if (request.type === "live.init") {
    if (sites.length === 0 || safeOrigin(request.url) !== senderOrigin) return null;
    const me = await api<{ id: string; displayName: string }>("/api/me");
    return {
      me: { id: me.id, displayName: me.displayName },
      projects: sites.map((s) => ({ id: s.projectId, name: s.projectName, organizationName: s.organizationName, myRole: s.myRole, canComment: canComment(s.myRole) })),
    } satisfies LiveInit;
  }

  // Every other request names a project, which must be live on this exact origin.
  if (!sites.some((s) => s.projectId === request.projectId)) throw new Error("This project isn't live on this site.");
  const projectPath = `/api/projects/${encodeURIComponent(request.projectId)}/live`;

  switch (request.type) {
    case "live.list":
      if (safeOrigin(request.url) !== senderOrigin) throw new Error("Wrong page.");
      return api<LivePage>(`${projectPath}/annotations?url=${encodeURIComponent(request.url)}`);
    case "live.create": {
      if (safeOrigin(request.url) !== senderOrigin) throw new Error("Wrong page.");
      const { type: _type, projectId: _projectId, ...body } = request;
      return postJson<LiveAnnotation>(`${projectPath}/annotations`, body);
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
  }
}

function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
