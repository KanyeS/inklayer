// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api";
import type { ReviewBrowser } from "../src/browser";
import { reviewTools } from "../src/tools";

const api = {
  json: vi.fn(async () => [
    { id: "p1", name: "Web app", organizationName: "Acme", myRole: "Commenter", canComment: true },
    { id: "p2", name: "Docs", organizationName: "Acme", myRole: "Viewer", canComment: false },
  ]),
} as unknown as Api;
const browser = {
  page: () => {
    throw new Error("No page is open: use open_page first.");
  },
} as unknown as ReviewBrowser;
const tools = reviewTools(api, browser);
const tool = (name: string) => {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name}`);
  return found;
};

describe("review tools", () => {
  it("offers the browser, recording and commenting tools, read-only where they only look", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "list_projects",
      "open_page",
      "page_outline",
      "screenshot",
      "click",
      "fill",
      "press",
      "scroll",
      "start_recording",
      "stop_recording",
      "comment",
      "close_browser",
    ]);
    expect(tools.filter((t) => t.readOnly).map((t) => t.name)).toEqual(["list_projects", "page_outline", "screenshot"]);
    expect(tool("comment").inputSchema.required).toEqual(["selector", "body"]);
  });

  it("lists projects with whether the person can comment", async () => {
    expect(await tool("list_projects").run({})).toEqual([
      { type: "text", text: "Web app (Acme), Commenter: p1\nDocs (Acme), Viewer, can't comment: p2" },
    ]);
  });

  it("asks for a page first", async () => {
    await expect(tool("click").run({ selector: "text=Save" })).rejects.toThrow("use open_page first");
  });
});
