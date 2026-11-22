import createClient, { type ClientOptions, type FetchResponse, type MaybeOptionalInit } from "openapi-fetch";
import type { HttpMethod, MediaType, PathsWithMethod, RequiredKeysOf } from "openapi-typescript-helpers";
import type { paths } from "./schema";

/**
 * The server's API, typed from its OpenAPI document. The types come from `schema.d.ts`, which `pnpm api:generate`
 * writes from `openapi.json`; a server test keeps that file in step with the server, so a change on one side that the
 * other doesn't expect fails a build instead of a user's request.
 */
export type * from "./schema";
export type { paths } from "./schema";

/** A request the server refused or failed. `message` is the problem details' detail or title, plus any field errors. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
  }
}

type InitParam<Init> =
  RequiredKeysOf<Init> extends never ? [(Init & { [key: string]: unknown })?] : [Init & { [key: string]: unknown }];

/** Calls one HTTP method: resolves with the response body, or throws ApiError. */
type Method<M extends HttpMethod> = <P extends PathsWithMethod<paths, M>, I extends MaybeOptionalInit<paths[P], M>>(
  url: P,
  ...init: InitParam<I>
) => Promise<NonNullable<FetchResponse<NonNullable<paths[P][M]>, I, MediaType>["data"]>>;

export interface Api {
  get: Method<"get">;
  post: Method<"post">;
  put: Method<"put">;
  patch: Method<"patch">;
  delete: Method<"delete">;
}

/** The response body of `M path` (GET by default), for naming types the schema only has inline. */
export type ResponseOf<P extends PathsWithMethod<paths, M>, M extends HttpMethod = "get"> = NonNullable<
  FetchResponse<NonNullable<paths[P][M]>, unknown, MediaType>["data"]
>;

/** How many times a request the server was too busy to take is sent again, and the longest wait between tries. */
const BUSY_RETRIES = 3;
const BUSY_MAX_WAIT_MS = 30_000;

/**
 * Wraps `fetch` so that a request the server was too busy to take (503 with Retry-After) is sent again after the wait it
 * asks for, with some jitter so refused clients don't all come back at once. The server refuses before a request reaches
 * its endpoint, so any request can be retried, writes included. Other failures are returned as they are. Unit-tested.
 */
export function retryWhenBusy(
  send: (request: Request) => Promise<Response>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): (request: Request) => Promise<Response> {
  return async (request) => {
    for (let attempt = 0; ; attempt++) {
      // A request's body can only be sent once: send a copy while another try may follow.
      const response = await send(attempt < BUSY_RETRIES ? request.clone() : request);
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (response.status !== 503 || !(retryAfter > 0) || attempt >= BUSY_RETRIES) return response;
      await response.body?.cancel();
      await sleep(Math.min(retryAfter * 1000, BUSY_MAX_WAIT_MS) * (1 + Math.random() * 0.5));
    }
  };
}

export function createApi(options: ClientOptions): Api {
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request));
  const client = createClient<paths>({ ...options, fetch: retryWhenBusy(send) });
  const call =
    (send: (url: never, init?: never) => Promise<{ data?: unknown; error?: unknown; response: Response }>) =>
    async (url: string, init?: object) => {
      const { data, error, response } = await send(url as never, init as never);
      if (!response.ok)
        throw new ApiError(response.status, errorMessage(response.status, error ?? null), error ?? null);
      return data;
    };
  return {
    get: call(client.GET as never) as Method<"get">,
    post: call(client.POST as never) as Method<"post">,
    put: call(client.PUT as never) as Method<"put">,
    patch: call(client.PATCH as never) as Method<"patch">,
    delete: call(client.DELETE as never) as Method<"delete">,
  };
}

/** The message for a failed request: its problem details' (RFC 9457) detail or title, then any field errors. Unit-tested. */
export function errorMessage(status: number, body: unknown): string {
  const problem = (typeof body === "object" ? body : null) as {
    title?: string;
    detail?: string;
    errors?: Record<string, string[]>;
  } | null;
  const details = problem?.errors ? Object.values(problem.errors).flat().join(" ") : "";
  return [problem?.detail ?? problem?.title ?? `Request failed (${status})`, details].filter(Boolean).join(" ");
}
