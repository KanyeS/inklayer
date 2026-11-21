import { describe, expect, it } from "vitest";
import { bytesToBase64 } from "../src/lib/base64";
import { HANDLED_REQUEST_TYPES, handleLive, isLiveRequest, matchPullRequest, safeOrigin } from "../src/lib/live";
import { cropFor } from "../src/lib/screenshots";
import { clampZoom } from "../src/lib/window-sizing";

describe("base64", () => {
  it("encodes like btoa", () => {
    expect(bytesToBase64(new TextEncoder().encode("Inklayer"))).toBe(btoa("Inklayer"));
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  it("handles data larger than one chunk", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(bytesToBase64(bytes)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});

describe("screenshot crop", () => {
  it("scales the CSS area to the image's pixels", () => {
    // A 2× display: the 800px-wide window was captured 1600 pixels wide.
    expect(cropFor({ width: 1600, height: 1200 }, { x: 10, y: 20, width: 100, height: 50 }, 800)).toEqual({
      sx: 20,
      sy: 40,
      sw: 200,
      sh: 100,
    });
  });

  it("stays inside the image", () => {
    const crop = cropFor({ width: 800, height: 600 }, { x: 700, y: 550, width: 300, height: 300 }, 800);
    expect(crop.sx + crop.sw).toBe(800);
    expect(crop.sy + crop.sh).toBe(600);
  });
});

describe("zoom", () => {
  it("keeps zoom within what browsers allow", () => {
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(9)).toBe(5);
  });
});

describe("pull request pages", () => {
  const linked = [
    "https://github.com/acme/shop/pull/12",
    "https://dev.azure.com/acme/Web%20Shop/_git/web/pullrequest/7",
  ];

  it("recognises a linked pull request and its tabs", () => {
    expect(matchPullRequest("https://github.com/acme/shop/pull/12", linked)).toBe(linked[0]);
    expect(matchPullRequest("https://github.com/acme/shop/pull/12/files", linked)).toBe(linked[0]);
    expect(matchPullRequest("https://dev.azure.com/acme/Web%20Shop/_git/web/pullrequest/7?_a=files", linked)).toBe(
      linked[1],
    );
  });

  it("ignores other pages, including other pull requests whose number starts the same", () => {
    expect(matchPullRequest("https://github.com/acme/shop/pull/123", linked)).toBeNull();
    expect(matchPullRequest("https://github.com/acme/shop/pulls", linked)).toBeNull();
    expect(matchPullRequest("https://github.com/acme/shop", linked)).toBeNull();
  });
});

describe("requests from pages", () => {
  it("only takes http(s) origins", () => {
    expect(safeOrigin("https://a.test/path?q#h")).toBe("https://a.test");
    expect(safeOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(safeOrigin("file:///etc/passwd")).toBeNull();
    expect(safeOrigin("chrome-extension://abc/popup.html")).toBeNull();
    expect(safeOrigin("nonsense")).toBeNull();
  });

  it("recognises live requests by their type", () => {
    expect(isLiveRequest({ type: "live.list" })).toBe(true);
    expect(isLiveRequest({ type: "presence.status" })).toBe(false);
    expect(isLiveRequest({})).toBe(false);
  });

  it("refuses a request from an unknown page", async () => {
    await expect(handleLive({ type: "live.inbox" }, undefined)).rejects.toThrow("Unknown page.");
    await expect(handleLive({ type: "live.inbox" }, "file:///x")).rejects.toThrow("Unknown page.");
  });

  it("refuses a request about another site than the page that sent it", async () => {
    await expect(
      handleLive({ type: "live.list", url: "https://bank.test/account" }, "https://evil.test/"),
    ).rejects.toThrow("Wrong page.");
  });

  it("needs the sender's window or tab for window requests", async () => {
    await expect(handleLive({ type: "live.restoreSize" }, "https://a.test/")).rejects.toThrow("Unknown window.");
    await expect(handleLive({ type: "live.getZoom" }, "https://a.test/")).rejects.toThrow("Unknown tab.");
  });

  it("handles every request type exactly once", () => {
    expect(new Set(HANDLED_REQUEST_TYPES).size).toBe(HANDLED_REQUEST_TYPES.length);
    expect(HANDLED_REQUEST_TYPES.every((t) => t.startsWith("live."))).toBe(true);
  });
});
