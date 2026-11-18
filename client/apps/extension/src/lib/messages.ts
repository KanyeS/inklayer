import type { Me } from "./api";

/** Messages from the popup to the background worker, and what each one returns. */
export type Request =
  | { type: "state" }
  | { type: "signIn" }
  | { type: "signOut" }
  | { type: "openLive"; tabId: number };

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
}

export async function send<K extends Request["type"]>(request: Extract<Request, { type: K }>): Promise<ResponseMap[K]> {
  const response = (await chrome.runtime.sendMessage(request)) as Response<ResponseMap[K]>;
  if (!response.ok) throw Object.assign(new Error(response.error), { notSignedIn: response.notSignedIn ?? false });
  return response.value;
}
