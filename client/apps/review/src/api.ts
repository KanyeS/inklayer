import type { Auth } from "./auth";

/**
 * Inklayer's API as the signed-in person. A 401 renews the token once (refresh, or sign in again) and retries.
 * Unit-tested: test/api.test.ts.
 */

export interface LiveProject {
  id: string;
  name: string;
  organizationId: string;
  organizationName: string;
  myRole: string;
  canComment: boolean;
}

export class Api {
  readonly #auth: Auth;
  readonly #fetch: typeof fetch;

  constructor(auth: Auth, fetchImpl: typeof fetch = fetch) {
    this.#auth = auth;
    this.#fetch = fetchImpl;
  }

  get serverUrl(): string {
    return this.#auth.serverUrl;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.#send(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (response.status === 204 ? null : await response.json()) as T;
  }

  /** Uploads a file's bytes (a screenshot or video). */
  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.#send(path, { method: "PUT", headers: { "Content-Type": contentType }, body: new Uint8Array(bytes) });
  }

  async #send(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.#auth.serverUrl);
    const attempt = (token: string) =>
      this.#fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
    let response = await attempt(await this.#auth.accessToken());
    if (response.status === 401) response = await attempt(await this.#auth.renew());
    if (!response.ok) throw new Error(`${init.method} ${path}: ${await problem(response)}`);
    return response;
  }
}

/** The server's problem title or message, else the status. */
async function problem(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    title?: string;
    detail?: string;
    errors?: unknown;
  } | null;
  const detail = body?.detail ?? body?.title;
  return detail ? `${response.status} ${detail}` : `${response.status} ${response.statusText}`;
}
