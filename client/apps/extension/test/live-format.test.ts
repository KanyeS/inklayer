import { describe, expect, it } from "vitest";
import type { PageContext } from "../src/lib/live";
import {
  addressOf,
  badgeCount,
  contextSummary,
  networkLine,
  pagePath,
  percent,
  plural,
  scopeOptions,
  timeAgo,
} from "../src/live/format";
import { TOOLS, toolHint } from "../src/live/labels";

describe("page addresses", () => {
  it("keys paths without a trailing slash, except the root", () => {
    expect(pagePath(new URL("https://a.test/"))).toBe("/");
    expect(pagePath(new URL("https://a.test/docs/"))).toBe("/docs");
    expect(pagePath(new URL("https://a.test/docs///"))).toBe("/docs");
    expect(pagePath(new URL("https://a.test/docs/page"))).toBe("/docs/page");
  });

  it("offers one scope for a plain address", () => {
    const options = scopeOptions("https://a.test/watch");
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ label: "Any version of this page", address: "/watch" });
  });

  it("offers this address when it has a query", () => {
    const options = scopeOptions("https://a.test/watch?v=1");
    expect(options.map((o) => o.label)).toEqual(["Any version of this page", "Only this address"]);
    expect(options[1]).toMatchObject({ scope: { query: true, hash: false }, address: "/watch?v=1" });
  });

  it("offers the #hash on its own or with the query", () => {
    expect(scopeOptions("https://a.test/doc#intro").map((o) => o.label)).toEqual([
      "Any version of this page",
      "Only this #hash",
    ]);
    const both = scopeOptions("https://a.test/doc?v=2#intro");
    expect(both.at(-1)).toMatchObject({
      label: "Only this address and #hash",
      scope: { query: true, hash: true },
      address: "/doc?v=2#intro",
    });
  });

  it("ignores an empty query or hash", () => {
    expect(scopeOptions("https://a.test/doc?#")).toHaveLength(1);
  });

  it("describes where an existing comment belongs", () => {
    expect(addressOf(null)).toBe("");
    expect(addressOf("https://a.test/watch/")).toBe("/watch (any version)");
    expect(addressOf("https://a.test/watch?v=1")).toBe("/watch?v=1");
    expect(addressOf("https://a.test/doc#part")).toBe("/doc#part");
    expect(addressOf("not a url")).toBe("not a url");
  });
});

describe("times and counts", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it.each([
    [0, "just now"],
    [59, "just now"],
    [60, "1m ago"],
    [59 * 60, "59m ago"],
    [3600, "1h ago"],
    [86400 * 2, "2d ago"],
    [604800 * 3, "3w ago"],
  ])("%i seconds ago is %s", (seconds, label) => {
    expect(timeAgo(ago(seconds), now)).toBe(label);
  });

  it("treats times in the future as just now", () => {
    expect(timeAgo(ago(-120), now)).toBe("just now");
  });

  it("pluralises", () => {
    expect(plural(1, "reply", "replies")).toBe("1 reply");
    expect(plural(2, "reply", "replies")).toBe("2 replies");
    expect(plural(0, "comment")).toBe("0 comments");
  });

  it("caps badge counts", () => {
    expect(badgeCount(7)).toBe("7");
    expect(badgeCount(99)).toBe("99");
    expect(badgeCount(100)).toBe("99+");
  });

  it("shows zoom as a percentage", () => {
    expect(percent(1)).toBe("100%");
    expect(percent(1.25)).toBe("125%");
    expect(percent(0.333)).toBe("33%");
  });
});

describe("page details", () => {
  const context: PageContext = {
    browser: "Chrome 130",
    os: "Windows",
    userAgent: "",
    viewportWidth: 1440,
    viewportHeight: 900,
    devicePixelRatio: 1,
    selector: "main > button",
    elementHtml: "",
    console: [
      { level: "error", message: "boom", at: "" },
      { level: "warn", message: "hmm", at: "" },
      { level: "error", message: "again", at: "" },
    ],
    network: [{ method: "GET", url: "/api", status: 500, ms: 120, at: "" }],
  };

  it("summarises browser, size, errors and failed requests", () => {
    expect(contextSummary(context)).toBe("Chrome 130 · Windows · 1440×900 · 2 console errors · 1 failed request");
  });

  it("mentions zoom only when it isn't 100%", () => {
    expect(contextSummary({ ...context, zoom: 1.005, console: [], network: [] })).toBe(
      "Chrome 130 · Windows · 1440×900",
    );
    expect(contextSummary({ ...context, zoom: 1.5, console: [], network: [] })).toBe(
      "Chrome 130 · Windows · 1440×900 at 150%",
    );
  });

  it("writes a failed request on one line", () => {
    expect(networkLine({ method: "GET", url: "/api", status: 500, ms: 120, at: "" })).toBe("GET /api → 500 (120 ms)");
    expect(networkLine({ method: "POST", url: "/x", status: 0, ms: 0, at: "" })).toBe("POST /x → failed");
  });
});

describe("tools", () => {
  it("lists every drawing tool once, starting with select", () => {
    const tools = TOOLS.map((t) => t.tool);
    expect(tools[0]).toBe("select");
    expect(new Set(tools).size).toBe(tools.length);
    expect(tools).toEqual(["select", "pin", "element", "highlight", "rect", "arrow", "ink"]);
  });

  it("says what to do with each tool", () => {
    expect(toolHint("highlight")).toBe("Select some text on the page.");
    expect(toolHint("pin")).toBe("Click something on the page.");
    expect(toolHint("element")).toBe("Click something on the page.");
    expect(toolHint("rect")).toBe("Drag on the page.");
    expect(toolHint("ink")).toBe("Drag on the page.");
  });
});
