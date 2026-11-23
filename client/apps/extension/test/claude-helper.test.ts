import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST, helperEnabled, helperStatus, improveDraft } from "../src/lib/claude-helper";
import { HANDLED_REQUEST_TYPES, handleLive } from "../src/lib/live";

/** A browser with the local Claude helper in some state: setting, permission, and what the helper answers. */
function browser(o: { on: boolean; permission: boolean; host?: (message: { type: string }) => unknown }) {
  const stored: Record<string, unknown> = {
    claudeImprove: o.on,
    serverUrl: "https://inklayer.example",
    tokens: { accessToken: "a", refreshToken: null, expiresAt: Date.now() + 60_000 },
  };
  const sendNativeMessage = vi.fn(async (_host: string, message: { type: string }) => {
    if (!o.host) throw new Error("Specified native messaging host not found.");
    return o.host(message);
  });
  vi.stubGlobal("chrome", {
    runtime: { sendNativeMessage },
    permissions: { contains: vi.fn(async () => o.permission) },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) =>
          Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).filter((k) => k in stored).map((k) => [k, stored[k]]),
          ),
        ),
        set: vi.fn(async (values: Record<string, unknown>) => void Object.assign(stored, values)),
      },
    },
  });
  return { stored, sendNativeMessage };
}

afterEach(() => vi.unstubAllGlobals());

describe("local Claude helper", () => {
  it("is off until the person turns it on and allows it", async () => {
    browser({ on: false, permission: true, host: () => ({ ok: true }) });
    expect(await helperStatus()).toEqual({ enabled: false, permission: true, ready: false, error: null });
    expect(await helperEnabled()).toBe(false);
    await expect(improveDraft({ text: "broken" })).rejects.toThrow("turned off");
  });

  it("says when the permission was taken away", async () => {
    browser({ on: true, permission: false });
    const status = await helperStatus();
    expect(status.ready).toBe(false);
    expect(status.ready === false && status.error).toContain("no longer has permission");
  });

  it("says how to install the helper when the browser can't find it", async () => {
    browser({ on: true, permission: true });
    const status = await helperStatus();
    expect(status.ready === false && status.error).toContain("isn't set up on this computer");
    expect(await helperEnabled()).toBe(false);
  });

  it("is ready once the helper answers, and rewrites drafts through it", async () => {
    const { sendNativeMessage } = browser({
      on: true,
      permission: true,
      host: (m) =>
        m.type === "ping" ? { ok: true, version: "1", claude: "2.1 (Claude Code)" } : { ok: true, text: "Better." },
    });
    expect(await helperStatus()).toEqual({ enabled: true, permission: true, ready: true, claude: "2.1 (Claude Code)" });
    expect(await helperEnabled()).toBe(true);
    expect(await improveDraft({ text: "bad", url: "https://site.example/", elementText: "x".repeat(5000) })).toBe(
      "Better.",
    );
    const [host, message] = sendNativeMessage.mock.calls[1] ?? [];
    expect(host).toBe(HOST);
    expect(message).toMatchObject({ type: "improve", text: "bad", url: "https://site.example/" });
    expect((message as unknown as { elementText: string }).elementText).toHaveLength(2000);
  });

  it("passes on what went wrong in the helper", async () => {
    browser({
      on: true,
      permission: true,
      host: (m) => (m.type === "ping" ? { ok: true } : { ok: false, error: "Not logged in" }),
    });
    await helperStatus();
    await expect(improveDraft({ text: "bad" })).rejects.toThrow("Not logged in");
  });

  it("is a live request pages can make, only about their own page", async () => {
    expect(HANDLED_REQUEST_TYPES).toContain("live.improve");
    browser({ on: true, permission: true, host: () => ({ ok: true, text: "Better." }) });
    await helperStatus();
    await expect(
      handleLive({ type: "live.improve", url: "https://other.example/", text: "x" }, "https://site.example/a"),
    ).rejects.toThrow("Wrong page.");
    expect(
      await handleLive({ type: "live.improve", url: "https://site.example/b", text: "x" }, "https://site.example/a"),
    ).toBe("Better.");
  });
});
