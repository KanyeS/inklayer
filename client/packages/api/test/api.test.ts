import { describe, expect, it } from "vitest";
import { ApiError, createApi, errorMessage, retryWhenBusy } from "../src/index";

describe("errorMessage", () => {
  it("prefers the problem's detail, then its title, then the status", () => {
    expect(errorMessage(409, { title: "Conflict", detail: "Changed by someone else." })).toBe(
      "Changed by someone else.",
    );
    expect(errorMessage(403, { title: "Forbidden" })).toBe("Forbidden");
    expect(errorMessage(500, null)).toBe("Request failed (500)");
    expect(errorMessage(502, "<html>bad gateway</html>")).toBe("Request failed (502)");
  });

  it("adds field errors after the title", () => {
    expect(errorMessage(400, { title: "Invalid.", errors: { name: ["Too long."], email: ["Required."] } })).toBe(
      "Invalid. Too long. Required.",
    );
  });
});

describe("createApi", () => {
  const recorded: Request[] = [];
  const api = createApi({
    baseUrl: "https://inklayer.test",
    fetch: async (request) => {
      recorded.push(request);
      if (request.url.endsWith("/api/docs/missing-doc")) {
        return new Response(JSON.stringify({ title: "Not found." }), { status: 404 });
      }
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ id: "d1", title: "Hello", path: new URL(request.url).pathname });
    },
  });

  it("fills in path and query parameters and returns the body", async () => {
    const doc = await api.get("/api/docs/{docId}", { params: { path: { docId: "d1" } } });
    expect(doc.title).toBe("Hello");
    await api.get("/api/orgs/{orgId}/docs/search", { params: { path: { orgId: "o1" }, query: { q: "a b" } } });
    expect(recorded.at(-1)?.url).toBe("https://inklayer.test/api/orgs/o1/docs/search?q=a%20b");
  });

  it("sends JSON bodies", async () => {
    await api.post("/api/orgs/{orgId}/docs", { params: { path: { orgId: "o1" } }, body: { title: "New" } });
    const request = recorded.at(-1);
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    expect(await request?.json()).toEqual({ title: "New" });
  });

  it("resolves empty responses", async () => {
    await expect(
      api.delete("/api/docs/{docId}", { params: { path: { docId: "d1" }, query: { version: 3 } } }),
    ).resolves.toBeUndefined();
  });

  it("throws ApiError with the server's message", async () => {
    const error = await api
      .get("/api/docs/{docId}", { params: { path: { docId: "missing-doc" } } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toBe("Not found.");
  });
});

describe("types (checked by tsc)", () => {
  it("rejects unknown paths, missing parameters and wrong bodies", () => {
    const api = createApi({ baseUrl: "https://inklayer.test", fetch: async () => Response.json({}) });
    const typed = async () => {
      const doc = await api.get("/api/docs/{docId}", { params: { path: { docId: "d1" } } });
      const version: number = doc.version;
      // @ts-expect-error: not a server path
      await api.get("/api/nope");
      // @ts-expect-error: docId is required
      await api.get("/api/docs/{docId}", { params: { path: {} } });
      // @ts-expect-error: title must be a string
      await api.post("/api/orgs/{orgId}/docs", { params: { path: { orgId: "o1" } }, body: { title: 1 } });
      return version;
    };
    expect(typed).toBeTypeOf("function");
  });
});

describe("retryWhenBusy", () => {
  const busy = (retryAfter: string | null = "2") =>
    new Response(JSON.stringify({ title: "The server is busy." }), {
      status: 503,
      headers: retryAfter ? { "Retry-After": retryAfter } : {},
    });

  function server(...responses: Response[]) {
    const bodies: string[] = [];
    const waits: number[] = [];
    const send = retryWhenBusy(
      async (request) => {
        bodies.push(await request.text());
        return responses.shift() ?? new Response("ok");
      },
      async (ms) => void waits.push(ms),
    );
    return { send, bodies, waits };
  }

  it("sends a refused request again, body and all, after the wait the server asks for", async () => {
    const { send, bodies, waits } = server(busy(), busy());
    const response = await send(new Request("https://inklayer.test/api/x", { method: "POST", body: "hello" }));
    expect(response.status).toBe(200);
    expect(bodies).toEqual(["hello", "hello", "hello"]);
    expect(waits).toHaveLength(2);
    for (const ms of waits) {
      expect(ms).toBeGreaterThanOrEqual(2000);
      expect(ms).toBeLessThanOrEqual(3000);
    }
  });

  it("gives up after three retries and returns the refusal", async () => {
    const { send, bodies } = server(busy(), busy(), busy(), busy(), busy());
    const response = await send(new Request("https://inklayer.test/api/x", { method: "PUT", body: "b" }));
    expect(response.status).toBe(503);
    expect(bodies).toHaveLength(4);
  });

  it("returns other failures, and a 503 without Retry-After, straight away", async () => {
    for (const failure of [new Response(null, { status: 500 }), busy(null), new Response(null, { status: 429 })]) {
      const { send, bodies } = server(failure);
      expect((await send(new Request("https://inklayer.test/api/x"))).status).toBe(failure.status);
      expect(bodies).toHaveLength(1);
    }
  });

  it("is used by createApi", async () => {
    let calls = 0;
    const api = createApi({
      baseUrl: "https://inklayer.test",
      fetch: async () => (++calls === 1 ? busy("0.001") : Response.json({ id: "d1", title: "Hi" })),
    });
    expect((await api.get("/api/docs/{docId}", { params: { path: { docId: "d1" } } })).title).toBe("Hi");
    expect(calls).toBe(2);
  });
});
