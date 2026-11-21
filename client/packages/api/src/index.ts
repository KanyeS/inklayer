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

export function createApi(options: ClientOptions): Api {
  const client = createClient<paths>(options);
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
