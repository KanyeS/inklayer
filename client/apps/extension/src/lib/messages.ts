import type { Me } from "./api";
import type { HelperStatus } from "./claude-helper";
import type { Inbox } from "./notifications";

/** Messages from the popup to the background worker, and what each one returns. */
export type Request =
  | { type: "state" }
  | { type: "signIn" }
  | { type: "signOut" }
  | { type: "openLive"; tabId: number; view?: "comments" | "activity" }
  | { type: "presenceState"; tabId: number }
  | { type: "setPresence"; tabId: number; on: boolean }
  | { type: "notifications" }
  | { type: "notificationsRead"; ids?: string[] }
  | { type: "connectedApps" }
  | { type: "claudeStatus" }
  | { type: "setClaudeImprove"; on: boolean };

export interface StateResponse {
  serverUrl: string | null;
  signedIn: boolean;
  me: Me | null;
  redirectUri: string;
}

export type Response<T> = { ok: true; value: T } | { ok: false; error: string; notSignedIn?: boolean };

export interface ResponseMap {
  state: StateResponse;
  signIn: null;
  signOut: null;
  openLive: null;
  presenceState: boolean;
  setPresence: null;
  notifications: Inbox;
  notificationsRead: null;
  /** How many AI assistants (MCP clients) the person has connected; the extension itself isn't one. */
  connectedApps: number;
  /** The local Claude helper: turned on, allowed, installed. */
  claudeStatus: HelperStatus;
  setClaudeImprove: HelperStatus;
}

/**
 * The extension's pages that send these requests, also when open in a tab (where the background would otherwise take
 * them for a web page's content script). A content script's sender is always its web page, never one of these.
 */
const OWN_PAGES = ["popup.html", "improve.html"];

export function isOwnPage(senderUrl: string | undefined, extensionRoot: string): boolean {
  return OWN_PAGES.some((page) => senderUrl?.startsWith(extensionRoot + page) === true);
}

export async function send<K extends Request["type"]>(request: Extract<Request, { type: K }>): Promise<ResponseMap[K]> {
  const response = (await chrome.runtime.sendMessage(request)) as Response<ResponseMap[K]> | undefined;
  if (!response) throw new Error("Inklayer didn't answer. Close this and try again.");
  if (!response.ok) throw Object.assign(new Error(response.error), { notSignedIn: response.notSignedIn ?? false });
  return response.value;
}
