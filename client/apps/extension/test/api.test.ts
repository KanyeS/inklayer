import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/settings", () => ({
  getSettings: () => Promise.resolve({ serverUrl: "https://inklayer.example.com", tokens: null }),
}));
vi.mock("../src/lib/auth", () => ({
  getAccessToken: () => Promise.resolve("token-1"),
  NotSignedInError: class extends Error {},
}));

const { api } = await import("../src/lib/api");

describe("authorizedFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the request's body even where Request.body isn't implemented (Firefox)", async () => {
    // Firefox has no Request.body: it reads as undefined even when the request has a body.
    vi.spyOn(Request.prototype, "body", "get").mockReturnValue(null);
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        sent.push({ url: url.toString(), init });
        return new Response(JSON.stringify({ id: "r1" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await api.post("/api/annotations/{annotationId}/replies", {
      params: { path: { annotationId: "a1" } },
      body: { body: "Looks fixed" },
    });

    expect(sent).toHaveLength(1);
    const [{ url, init }] = sent as [{ url: string; init: RequestInit }];
    expect(url).toBe("https://inklayer.example.com/api/annotations/a1/replies");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"body":"Looks fixed"}');
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("sends no body for GET", async () => {
    const fetch = vi.fn(
      async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetch);
    await api.get("/api/live/annotations", { params: { query: { url: "https://example.com/" } } });
    expect((fetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body).toBeUndefined();
  });
});
