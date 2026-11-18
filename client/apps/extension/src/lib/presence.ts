import { HttpTransportType, HubConnectionBuilder, HubConnectionState, LogLevel, type HubConnection } from "@microsoft/signalr";
import { api, postJson, type Features } from "./api";
import { getSettings } from "./settings";
import { PRESENCE_PORT, type PresenceDown, type PresencePeer, type PresenceUp } from "./presence-protocol";

export { PRESENCE_PORT };

/**
 * Live presence, background side: one SignalR connection per browser, shared by every tab where the user turned it on.
 * <ul>
 * <li>Opt-in per tab. The flag lives in session storage, so it survives reloads in that tab and ends with the tab.</li>
 * <li>Each live tab opens a port. The page's address is turned into a hash here (origin + path), and only the hash goes
 * to the server, so the server never learns which pages people are on.</li>
 * <li>The connection is opened with a single-use ticket bought with the access token; the token never enters a URL or a page.</li>
 * </ul>
 */

interface TabPort {
  port: chrome.runtime.Port;
  origin: string;
  page: string | null;
}

const STORAGE_KEY = "presenceTabs";
const STOP_AFTER_MS = 30_000;
const RETRY_AFTER_MS = 15_000;

const ports = new Set<TabPort>();
/** Page hash → how many of this browser's tabs are on it. */
const joined = new Map<string, number>();
let connection: HubConnection | null = null;
let starting: Promise<void> | null = null;
let stopTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let lastStatus: PresenceDown = { t: "status", status: "connecting" };

/* -------------------------------------------------------------------- the per-tab opt-in */

async function liveTabs(): Promise<number[]> {
  const stored = await chrome.storage.session.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as number[] | undefined) ?? [];
}

export async function isPresenceOn(tabId: number): Promise<boolean> {
  return (await liveTabs()).includes(tabId);
}

/** Turns presence on or off for a tab, and tells the tab. */
export async function setPresence(tabId: number, on: boolean): Promise<void> {
  const tabs = new Set(await liveTabs());
  if (on) tabs.add(tabId);
  else tabs.delete(tabId);
  await chrome.storage.session.set({ [STORAGE_KEY]: [...tabs] });
  await showBadge(tabId, on);
  if (on) await chrome.scripting.executeScript({ target: { tabId }, files: ["live.js"] }); // a no-op if it's already there
  await chrome.tabs.sendMessage(tabId, { type: "inklayer.presence", on }).catch(() => undefined);
}

/** Signed out: every tab stops sharing. */
export async function stopPresence(): Promise<void> {
  const tabs = await liveTabs();
  await chrome.storage.session.remove(STORAGE_KEY);
  for (const tabId of tabs) {
    await showBadge(tabId, false);
    await chrome.tabs.sendMessage(tabId, { type: "inklayer.presence", on: false }).catch(() => undefined);
  }
  for (const tab of ports) tab.port.disconnect();
  ports.clear();
  joined.clear();
  await stopConnection();
}

export async function forgetTab(tabId: number): Promise<void> {
  const tabs = await liveTabs();
  if (tabs.includes(tabId)) await chrome.storage.session.set({ [STORAGE_KEY]: tabs.filter((t) => t !== tabId) });
}

async function showBadge(tabId: number, on: boolean): Promise<void> {
  await chrome.action.setBadgeText({ tabId, text: on ? "LIVE" : "" }).catch(() => undefined);
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0ACF83" }).catch(() => undefined);
}

/* -------------------------------------------------------------------- ports from live tabs */

/** A live tab connected. Only accepted from this extension's content script, in a tab the user turned presence on for. */
export async function acceptPort(port: chrome.runtime.Port): Promise<void> {
  const tabId = port.sender?.tab?.id;
  const origin = port.sender?.url ? safeOrigin(port.sender.url) : null;
  if (port.sender?.id !== chrome.runtime.id || tabId === undefined || !origin || !(await isPresenceOn(tabId))) {
    port.disconnect();
    return;
  }

  const tab: TabPort = { port, origin, page: null };
  ports.add(tab);
  clearTimeout(stopTimer);
  void showBadge(tabId, true);
  port.postMessage(lastStatus);
  port.onMessage.addListener((message: PresenceUp) => void onTabMessage(tab, message));
  port.onDisconnect.addListener(() => {
    ports.delete(tab);
    void leave(tab);
    if (ports.size === 0) stopTimer = setTimeout(() => void stopConnection(), STOP_AFTER_MS);
  });
}

async function onTabMessage(tab: TabPort, message: PresenceUp): Promise<void> {
  switch (message.t) {
    case "join": {
      // The page can only name an address on its own site.
      if (safeOrigin(message.url) !== tab.origin) return;
      const page = await pageHash(message.url);
      if (page === tab.page) return;
      await leave(tab);
      tab.page = page;
      joined.set(page, (joined.get(page) ?? 0) + 1);
      if (connection?.state === HubConnectionState.Connected) await joinPage(page);
      else void connect();
      return;
    }
    case "cursor":
      return send(tab, "Cursor", message.data);
    case "select":
      return send(tab, "Select", message.data ?? null);
    case "idle":
      return send(tab, "Idle");
  }
}

async function leave(tab: TabPort): Promise<void> {
  const page = tab.page;
  if (!page) return;
  tab.page = null;
  const count = (joined.get(page) ?? 1) - 1;
  if (count > 0) {
    joined.set(page, count);
    return;
  }
  joined.delete(page);
  if (connection?.state === HubConnectionState.Connected) await connection.invoke("Leave", page).catch(() => undefined);
}

async function send(tab: TabPort, method: "Cursor" | "Select" | "Idle", data?: unknown): Promise<void> {
  if (!tab.page || connection?.state !== HubConnectionState.Connected) return;
  const args = method === "Idle" ? [tab.page] : [tab.page, data];
  await connection.send(method, ...args).catch(() => undefined);
}

function toPage(page: string, message: PresenceDown): void {
  for (const tab of ports) if (tab.page === page) tab.port.postMessage(message);
}

function toAll(message: PresenceDown): void {
  if (message.t === "status") lastStatus = message;
  for (const tab of ports) tab.port.postMessage(message);
}

/* -------------------------------------------------------------------- the hub connection */

function connect(): Promise<void> {
  clearTimeout(retryTimer);
  if (connection) return Promise.resolve(); // connected or reconnecting; pages are joined when it's ready
  starting ??= (async () => {
    const { serverUrl } = await getSettings();
    if (!serverUrl) throw new Error("Not signed in to Inklayer.");
    // Turned off by an administrator: say so, and don't keep retrying.
    if (!(await api<Features>("/api/features")).liveCursors) {
      toAll({ t: "status", status: "offline", error: "Live cursors are turned off on this server." });
      return;
    }
    const hub = new HubConnectionBuilder()
      .withUrl(new URL("/api/presence/hub", serverUrl).href, {
        transport: HttpTransportType.WebSockets,
        skipNegotiation: true,
        // Called again on every reconnect, so each connection attempt gets a fresh ticket.
        accessTokenFactory: async () => (await postJson<{ ticket: string }>("/api/presence/ticket", {})).ticket,
      })
      .withAutomaticReconnect([0, 2_000, 5_000, 10_000, 30_000])
      .configureLogging(LogLevel.Warning)
      .build();

    hub.on("peerJoin", (page: string, peer: PresencePeer) => toPage(page, { t: "peerJoin", peer }));
    hub.on("peerLeave", (page: string, id: string) => toPage(page, { t: "peerLeave", id }));
    hub.on("cursor", (page: string, id: string, data: unknown) => toPage(page, { t: "cursor", id, data }));
    hub.on("select", (page: string, id: string, data: unknown) => toPage(page, { t: "select", id, data }));
    hub.on("idle", (page: string, id: string) => toPage(page, { t: "idle", id }));
    hub.onreconnecting(() => toAll({ t: "status", status: "connecting" }));
    // The server forgets rooms when a connection drops: join them again.
    hub.onreconnected(() => void joinAll());
    hub.onclose((error) => {
      if (connection === hub) connection = null;
      toAll({ t: "status", status: "offline", error: error ? "Lost the connection to Inklayer." : undefined });
      if (ports.size > 0) retryTimer = setTimeout(() => void connect(), RETRY_AFTER_MS);
    });

    toAll({ t: "status", status: "connecting" });
    try {
      await hub.start();
    } catch (error) {
      toAll({ t: "status", status: "offline", error: "Couldn't connect to Inklayer." });
      if (ports.size > 0) retryTimer = setTimeout(() => void connect(), RETRY_AFTER_MS);
      throw error;
    }
    connection = hub;
    await joinAll();
  })()
    .catch(() => undefined)
    .finally(() => {
      starting = null;
    });
  return starting;
}

async function joinAll(): Promise<void> {
  for (const page of joined.keys()) await joinPage(page);
  toAll({ t: "status", status: "live" });
}

async function joinPage(page: string): Promise<void> {
  if (!connection) return;
  try {
    const peers = await connection.invoke<PresencePeer[]>("Join", page);
    toPage(page, { t: "peers", peers });
    toPage(page, { t: "status", status: "live" });
  } catch (error) {
    toPage(page, { t: "status", status: "offline", error: error instanceof Error ? cleanError(error.message) : "Couldn't go live on this page." });
  }
}

async function stopConnection(): Promise<void> {
  clearTimeout(retryTimer);
  const hub = connection;
  connection = null;
  lastStatus = { t: "status", status: "connecting" };
  await hub?.stop().catch(() => undefined);
}

/* -------------------------------------------------------------------- page identity */

/** The page path as the server keys comments: without a trailing slash, except for the root. */
function pagePath(url: URL): string {
  return url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") || "/" : url.pathname;
}

/** The hex SHA-256 of the page's origin and path. Query and #hash are left out, like "any version of this page" for comments. */
export async function pageHash(href: string): Promise<string> {
  const url = new URL(href);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.origin + pagePath(url)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SignalR prefixes server errors with the method call; show only the message. */
function cleanError(message: string): string {
  return message.replace(/^.*HubException:\s*/, "");
}

function safeOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
