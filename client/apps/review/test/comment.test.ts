// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import type { Api, LiveProject } from "../src/api";
import type { Recording } from "../src/browser";
import { annotationBody, chooseProject, DEFAULT_COLOR, pageContext, postComment } from "../src/comment";
import type { Described } from "../src/page/describe";

const project = (id: string, canComment = true): LiveProject => ({
  id,
  name: `Project ${id}`,
  organizationId: "o",
  organizationName: "Acme",
  myRole: canComment ? "Commenter" : "Viewer",
  canComment,
});

const described: Described = {
  anchor: {
    element: {
      path: ["form > button"],
      xpath: null,
      tag: "button",
      text: "Save",
      box: { x: 0, y: 0, width: 80, height: 30 },
    },
  },
  selector: "form > button",
  elementHtml: "<button>Save</button>",
  rect: { x: 600, y: 300, width: 80, height: 30 },
  viewport: { width: 1280, height: 800 },
  devicePixelRatio: 1,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/159.0.0.0 Safari/537.36",
  timeZone: "Australia/Brisbane",
  utcOffsetMinutes: 600,
};

describe("choosing the project", () => {
  it("takes the only one the person can comment in", () => {
    expect(chooseProject([project("a"), project("b", false)]).id).toBe("a");
  });

  it("asks which one when there are several, and refuses ones they can't comment in", () => {
    expect(() => chooseProject([project("a"), project("b")])).toThrow(
      "Say which project with project_id: Project a (Acme): a",
    );
    expect(() => chooseProject([project("a"), project("b", false)], "b")).toThrow("You can't comment in Project b");
    expect(() => chooseProject([project("a")], "zzz")).toThrow("No project zzz");
    expect(() => chooseProject([project("b", false)])).toThrow("can't comment in any project");
  });
});

describe("the comment's placement", () => {
  it("outlines the element by default, for every version of the page", () => {
    expect(annotationBody({ selector: "button", body: "Broken" }, described, "https://site.example/a?tab=2#x")).toEqual(
      {
        url: "https://site.example/a?tab=2#x",
        kind: "Element",
        body: "Broken",
        color: DEFAULT_COLOR,
        anchor: described.anchor,
        geometry: { kind: "Element" },
        viewportWidth: 1280,
        includeQuery: false,
        includeHash: false,
      },
    );
  });

  it("can pin a point, for just this address", () => {
    expect(
      annotationBody(
        { selector: "button", body: "x", mark: "pin", exactAddress: true },
        described,
        "https://site.example/a?tab=2",
      ),
    ).toMatchObject({
      kind: "Pin",
      geometry: { kind: "Pin", point: { x: 0.5, y: 0.5 } },
      includeQuery: true,
      includeHash: false,
    });
  });

  it("gives the page's details as the extension does", () => {
    const log = [{ level: "error", message: "boom", at: "2026-11-22T00:00:00Z" }];
    expect(pageContext(described, { console: log, network: [] })).toMatchObject({
      browser: "Chrome 159",
      os: "Linux",
      selector: "form > button",
      console: log,
      timeZone: "Australia/Brisbane",
    });
  });
});

describe("leaving a comment", () => {
  function fakes(o: { failScreenshot?: boolean } = {}) {
    const calls: { method: string; path: string; body?: unknown; type?: string }[] = [];
    const api = {
      json: vi.fn(async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        if (path === "/api/live/projects") return [project("p1")];
        if (method === "POST") return { id: "c1" };
        return null;
      }),
      put: vi.fn(async (path: string, _bytes: Uint8Array, type: string) => {
        if (o.failScreenshot && path.includes("/screenshot")) throw new Error("403 Bug context is turned off.");
        calls.push({ method: "PUT", path, type });
      }),
    } as unknown as Api;
    const locator = {
      first: () => locator,
      scrollIntoViewIfNeeded: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => described),
    };
    const page = {
      url: () => "https://site.example/settings",
      locator: () => locator,
      screenshot: vi.fn(async () => Buffer.from("jpeg")),
    } as unknown as Page;
    return { api, page, calls };
  }

  it("saves it, then attaches the screenshot, the page's details and the recording", async () => {
    const { api, page, calls } = fakes();
    const dir = mkdtempSync(join(tmpdir(), "inklayer-comment-test-"));
    const path = join(dir, "video.webm");
    writeFileSync(path, "webm");
    const recording: Recording = { path, seconds: 12, poster: Buffer.from("poster"), width: 1280, height: 800 };
    const created = await postComment(
      api,
      { page, console: [], network: [], takeRecording: () => recording },
      { selector: "text=Save", body: "Saving does nothing." },
    );
    expect(created).toMatchObject({
      id: "c1",
      attached: ["screenshot", "page details", "recording (12s)"],
      problems: [],
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/live/projects",
      "POST /api/projects/p1/live/annotations",
      "PUT /api/annotations/c1/screenshot?width=480&height=300",
      "PUT /api/annotations/c1/context",
      "PUT /api/annotations/c1/media/video?width=1280&height=800",
      "PUT /api/annotations/c1/media/thumbnail",
    ]);
    expect(calls.find((c) => c.path.includes("/video"))?.type).toBe("video/webm");
  });

  it("keeps the comment when something can't be attached, and says why", async () => {
    const { api, page } = fakes({ failScreenshot: true });
    const created = await postComment(
      api,
      { page, console: [], network: [], takeRecording: () => null },
      { selector: "text=Save", body: "x" },
    );
    expect(created.attached).toEqual(["page details"]);
    expect(created.problems).toEqual(["screenshot: 403 Bug context is turned off."]);
  });

  it("says when the element isn't there", async () => {
    const { api, page } = fakes();
    (
      page.locator("x") as unknown as { scrollIntoViewIfNeeded: ReturnType<typeof vi.fn> }
    ).scrollIntoViewIfNeeded.mockRejectedValue(new Error("timeout"));
    await expect(
      postComment(api, { page, console: [], network: [], takeRecording: () => null }, { selector: "#nope", body: "x" }),
    ).rejects.toThrow("Nothing on the page matches #nope");
  });

  it("needs some text", async () => {
    const { api, page } = fakes();
    await expect(
      postComment(api, { page, console: [], network: [], takeRecording: () => null }, { selector: "a", body: " " }),
    ).rejects.toThrow("Write the comment's text");
  });
});
