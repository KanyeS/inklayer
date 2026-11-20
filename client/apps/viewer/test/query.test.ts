import { MutationObserver, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { createQueryClient, shouldRetry } from "../src/lib/query";

describe("shouldRetry", () => {
  it("doesn't retry requests the server refused", () => {
    expect(shouldRetry(0, new ApiError(404, "Not found", null))).toBe(false);
    expect(shouldRetry(0, new ApiError(403, "Forbidden", null))).toBe(false);
  });

  it("retries server errors and network failures, twice", () => {
    expect(shouldRetry(0, new ApiError(503, "Unavailable", null))).toBe(true);
    expect(shouldRetry(1, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(2, new TypeError("Failed to fetch"))).toBe(false);
  });
});

describe("after a change", () => {
  it("refetches what's on screen before the change resolves", async () => {
    const client = createQueryClient();
    let fetches = 0;
    const shown = new QueryObserver(client, { queryKey: ["doc"], queryFn: async () => ++fetches });
    const stop = shown.subscribe(() => undefined);
    await vi.waitFor(() => expect(fetches).toBe(1));

    await new MutationObserver(client, { mutationFn: async () => "saved" }).mutate();
    expect(fetches).toBe(2);

    // A failed change refreshes too: it may have shown the data was out of date.
    const failed = new MutationObserver(client, { mutationFn: () => Promise.reject(new Error("conflict")) });
    await failed.mutate().catch(() => undefined);
    expect(fetches).toBe(3);
    stop();
  });
});
