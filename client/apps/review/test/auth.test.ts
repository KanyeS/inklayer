// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Auth, CLIENT_ID } from "../src/auth";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tokenFile(contents?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "inklayer-auth-test-"));
  dirs.push(dir);
  const file = join(dir, "review.json");
  if (contents) writeFileSync(file, JSON.stringify(contents));
  return file;
}

/** A token endpoint that hands out numbered tokens, and records what it was sent. */
function tokenServer() {
  const forms: URLSearchParams[] = [];
  let n = 0;
  const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    forms.push(new URLSearchParams(String(init?.body)));
    n++;
    return Response.json({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 });
  });
  return { forms, fetch: fetchImpl as unknown as typeof fetch };
}

const SERVER = "https://inklayer.example/some/path";

describe("review helper sign-in", () => {
  it("uses a saved token while it's valid", async () => {
    const file = tokenFile({
      "https://inklayer.example": { accessToken: "saved", refreshToken: "r", expiresAt: Date.now() + 600_000 },
    });
    const server = tokenServer();
    const auth = new Auth({ serverUrl: SERVER, file, fetch: server.fetch });
    expect(await auth.accessToken()).toBe("saved");
    expect(server.forms).toHaveLength(0);
  });

  it("refreshes an expired token, and saves the new one where only the person can read it", async () => {
    const file = tokenFile({
      "https://inklayer.example": { accessToken: "old", refreshToken: "refresh-old", expiresAt: Date.now() - 1 },
      "https://other.example": { accessToken: "other", refreshToken: null, expiresAt: 0 },
    });
    const server = tokenServer();
    const auth = new Auth({ serverUrl: SERVER, file, fetch: server.fetch });
    expect(await auth.accessToken()).toBe("access-1");
    expect(Object.fromEntries(server.forms[0] ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
      client_id: CLIENT_ID,
    });
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved["https://inklayer.example"].refreshToken).toBe("refresh-1");
    expect(saved["https://other.example"].accessToken).toBe("other");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("signs in through the browser with PKCE, receiving the code on a loopback address", async () => {
    const server = tokenServer();
    const opened: string[] = [];
    const auth = new Auth({
      serverUrl: SERVER,
      file: tokenFile(),
      fetch: server.fetch,
      log: () => undefined,
      openUrl: (url) => {
        opened.push(url);
        // The person signs in and allows the helper: the server sends the browser back with a code.
        const asked = new URL(url);
        const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
        back.search = new URLSearchParams({
          code: "the-code",
          state: asked.searchParams.get("state") ?? "",
        }).toString();
        void fetch(back);
      },
    });

    expect(await auth.accessToken()).toBe("access-1");
    const asked = new URL(opened[0] ?? "");
    expect(asked.origin + asked.pathname).toBe("https://inklayer.example/connect/authorize");
    expect(asked.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(asked.searchParams.get("code_challenge_method")).toBe("S256");
    expect(asked.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:4782[123]\/callback$/);
    const form = Object.fromEntries(server.forms[0] ?? []);
    expect(form).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: CLIENT_ID });
    expect(form.code_verifier).toHaveLength(43);
  });

  it("ignores answers to sign-ins it didn't start, and stops when the person says no", async () => {
    const auth = new Auth({
      serverUrl: SERVER,
      file: tokenFile(),
      fetch: tokenServer().fetch,
      log: () => undefined,
      openUrl: async (url) => {
        const asked = new URL(url);
        const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
        back.search = new URLSearchParams({ code: "forged", state: "wrong" }).toString();
        expect(await (await fetch(back)).text()).toContain("wasn't started by the review helper");
        back.search = new URLSearchParams({
          error: "access_denied",
          state: asked.searchParams.get("state") ?? "",
        }).toString();
        await fetch(back);
      },
    });
    await expect(auth.accessToken()).rejects.toThrow("Sign-in ended: access_denied");
  });

  it("says when the server refuses", async () => {
    const file = tokenFile({
      "https://inklayer.example": { accessToken: "old", refreshToken: "revoked", expiresAt: 0 },
    });
    const refused = vi.fn(async () =>
      Response.json({ error: "invalid_grant", error_description: "The token was revoked." }, { status: 400 }),
    );
    const auth = new Auth({
      serverUrl: SERVER,
      file,
      fetch: refused as unknown as typeof fetch,
      log: () => undefined,
      openUrl: (url) => {
        const asked = new URL(url);
        const back = new URL(asked.searchParams.get("redirect_uri") ?? "");
        back.search = new URLSearchParams({ code: "c", state: asked.searchParams.get("state") ?? "" }).toString();
        void fetch(back);
      },
    });
    await expect(auth.accessToken()).rejects.toThrow("The token was revoked.");
  });
});
