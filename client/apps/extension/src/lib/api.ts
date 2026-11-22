import { ApiError, createApi, retryWhenBusy } from "@inklayer/api";
import { getAccessToken, NotSignedInError } from "./auth";
import { getSettings } from "./settings";

export type { FeaturesResponse as Features, MeResponse as Me } from "@inklayer/api";
export { ApiError } from "@inklayer/api";

/** The client builds requests against this placeholder; `authorizedFetch` sends them to the signed-in server. */
const PLACEHOLDER = "https://inklayer.invalid";

/**
 * Sends a request to the signed-in Inklayer server with the extension's bearer token, refreshing the token once on 401.
 * Throws NotSignedInError when there's no server or the refreshed token is refused too.
 */
async function authorizedFetch(request: Request): Promise<Response> {
  const { serverUrl } = await getSettings();
  if (!serverUrl) throw new NotSignedInError();
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, serverUrl);
  // The body can only be read once; keep a copy for the retry. Read it whatever `request.body` says: Firefox doesn't
  // implement `Request.body`, so it's always undefined there, even when there is one.
  const bytes = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = bytes?.byteLength ? bytes : undefined;

  const send = (token: string) => {
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(target, { method: request.method, headers, body });
  };
  let response = await send(await getAccessToken());
  if (response.status === 401) response = await send(await getAccessToken(true));
  if (response.status === 401) throw new NotSignedInError();
  return response;
}

/** The Inklayer API, typed from the server's OpenAPI document (see @inklayer/api). */
export const api = createApi({ baseUrl: PLACEHOLDER, fetch: authorizedFetch });

/** For requests made outside `api`: sent again, after a wait, when the server is too busy to take them. */
const busyAwareFetch = retryWhenBusy(authorizedFetch);

/** Sends raw bytes (such as a screenshot) to `path`. */
export async function putBytes(path: string, body: Blob): Promise<void> {
  const response = await busyAwareFetch(
    new Request(new URL(path, PLACEHOLDER), { method: "PUT", headers: { "Content-Type": body.type }, body }),
  );
  if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`, null);
}

/** Fetches binary content (such as a screenshot). Null if there's none (404). */
export async function apiBytes(path: string): Promise<{ bytes: ArrayBuffer; type: string } | null> {
  const response = await busyAwareFetch(new Request(new URL(path, PLACEHOLDER)));
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status, `Request failed (${response.status})`, null);
  return { bytes: await response.arrayBuffer(), type: response.headers.get("Content-Type") ?? "image/webp" };
}
