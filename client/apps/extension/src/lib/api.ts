import { NotSignedInError, getAccessToken } from "./auth";
import { getSettings } from "./settings";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: unknown) {
    super(message);
  }
}

/** Calls the Inklayer API with the extension's bearer token, refreshing once on 401. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { serverUrl } = await getSettings();
  if (!serverUrl) throw new NotSignedInError();

  const send = async (token: string) =>
    fetch(new URL(path, serverUrl), { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });

  let response = await send(await getAccessToken());
  if (response.status === 401) response = await send(await getAccessToken(true));
  if (response.status === 401) throw new NotSignedInError();

  const text = await response.text();
  const body: unknown = text ? safeJson(text) : null;
  if (!response.ok) {
    const problem = body as { title?: string; detail?: string } | null;
    throw new ApiError(response.status, problem?.detail ?? problem?.title ?? `Request failed (${response.status}).`, body);
  }
  return body as T;
}

export const postJson = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Response shapes used by the extension.
export interface Me {
  id: string;
  email: string;
  displayName: string;
  organizations: { id: string; name: string; role: string }[];
}

export interface Project {
  id: string;
  name: string;
  myRole: string;
}

export interface Snapshot {
  id: string;
  title: string;
  url: string;
  viewUrl: string | null;
}
