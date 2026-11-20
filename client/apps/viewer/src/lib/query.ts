import { MutationCache, QueryClient, useMutation } from "@tanstack/react-query";
import { useCallback } from "react";
import { ApiError } from "./api";

/**
 * Server data in the viewer goes through TanStack Query: cached, shared between components that ask for the same
 * thing, and refetched when the tab regains focus. After any change made through `useAction`, every query is marked
 * stale and the ones on screen refetch, so a save shows up everywhere without components passing reload callbacks.
 */

/** Whether a failed request is worth trying again: not when the server refused it (4xx), and at most twice. Unit-tested. */
export function shouldRetry(failures: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failures < 2;
}

export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 10_000 },
    },
    mutationCache: new MutationCache({
      // Successful or not: a failed save may still have changed something (or shown that the data was out of date).
      onSettled: () => client.invalidateQueries(),
    }),
  });
  return client;
}

export const queryClient = createQueryClient();

/** Refreshes what's on screen after a change made outside `useAction` (by code that handles its own errors). */
export const refreshAll = () => queryClient.invalidateQueries();

export type ActionResult<T> = { ok: true; value: T } | { ok: false };

/**
 * Runs changes (saves, deletes) and refreshes what's on screen afterwards. `run` never throws: it resolves to the
 * action's result, or to `{ ok: false }` with `error` holding why (until the next run).
 */
export function useAction() {
  const mutation = useMutation({ mutationFn: (action: () => Promise<unknown>) => action() });
  const { mutateAsync, reset } = mutation;
  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<ActionResult<T>> => {
      try {
        return { ok: true, value: (await mutateAsync(action)) as T };
      } catch {
        return { ok: false };
      }
    },
    [mutateAsync],
  );
  return { run, error: mutation.error, pending: mutation.isPending, reset };
}
