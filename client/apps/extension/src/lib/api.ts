import { getAccessToken, NotSignedInError } from "./auth";
import { getSettings } from "./settings";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
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
    throw new ApiError(
      response.status,
      problem?.detail ?? problem?.title ?? `Request failed (${response.status}).`,
      body,
    );
  }
  return body as T;
}

/** Fetches binary content (such as a screenshot) with the extension's bearer token. Null if there's none (404). */
export async function apiBytes(path: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const { serverUrl } = await getSettings();
  if (!serverUrl) throw new NotSignedInError();
  const send = async (token: string) =>
    fetch(new URL(path, serverUrl), { headers: { Authorization: `Bearer ${token}` } });
  let response = await send(await getAccessToken());
  if (response.status === 401) response = await send(await getAccessToken(true));
  if (response.status === 401) throw new NotSignedInError();
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status}).`, null);
  return { bytes: await response.arrayBuffer(), type: response.headers.get("Content-Type") ?? "image/webp" };
}

export const putJson = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

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
  /** Which major features are on for this server. */
  features: Features;
}

export interface Features {
  docs: boolean;
  liveCursors: boolean;
  mcp: boolean;
  bugContext: boolean;
  issueTrackers: boolean;
  sharing: boolean;
}
