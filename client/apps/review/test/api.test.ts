// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { Api } from "../src/api";
import type { Auth } from "../src/auth";

function fakeAuth() {
  let n = 0;
  return {
    serverUrl: "https://inklayer.example",
    accessToken: vi.fn(async () => "first"),
    renew: vi.fn(async () => `renewed-${++n}`),
  } as unknown as Auth & { renew: ReturnType<typeof vi.fn> };
}

describe("review helper API client", () => {
  it("sends JSON with the person's token", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ id: "c1" }, { status: 201 }));
    const api = new Api(fakeAuth(), fetchImpl as unknown as typeof fetch);
    expect(await api.json("POST", "/api/projects/p/live/annotations", { body: "x" })).toEqual({ id: "c1" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://inklayer.example/api/projects/p/live/annotations");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer first" });
    expect(init.body).toBe('{"body":"x"}');
  });

  it("renews the token once after a 401", async () => {
    const auth = fakeAuth();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = new Api(auth, fetchImpl as unknown as typeof fetch);
    await api.put("/api/annotations/c1/screenshot", new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(auth.renew).toHaveBeenCalledOnce();
    const [, retried] = fetchImpl.mock.calls[1] as [URL, RequestInit];
    expect(retried.headers).toMatchObject({ Authorization: "Bearer renewed-1" });
  });

  it("explains what the server refused", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ title: "You can't comment in this project." }, { status: 403 }),
    );
    const api = new Api(fakeAuth(), fetchImpl as unknown as typeof fetch);
    await expect(api.json("GET", "/api/live/projects")).rejects.toThrow(
      "GET /api/live/projects: 403 You can't comment in this project.",
    );
  });
});
