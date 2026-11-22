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

export async function send<K extends Request["type"]>(request: Extract<Request, { type: K }>): Promise<ResponseMap[K]> {
  const response = (await chrome.runtime.sendMessage(request)) as Response<ResponseMap[K]>;
  if (!response.ok) throw Object.assign(new Error(response.error), { notSignedIn: response.notSignedIn ?? false });
  return response.value;
}
