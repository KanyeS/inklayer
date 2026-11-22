import type { Api, LiveProject } from "./api";
import type { ReviewBrowser } from "./browser";
import { postComment } from "./comment";
import { type Content, image, type Tool, text } from "./mcp";

/** The tools Claude Code sees. Unit-tested: test/tools.test.ts. */

export const INSTRUCTIONS = `Review a web page or feature in a real browser and leave Inklayer comments on it, as the signed-in person.
Open the page with open_page, find elements with page_outline, try things with click, fill, press and scroll, and look with screenshot.
To show a problem in motion, start_recording before the steps and stop_recording after: the next comment gets the video.
Leave each finding with comment, on the element it's about: say what's wrong, the steps, expected and actual.
The first time, Inklayer asks the person to sign in and allow the helper in their browser.
For replies, resolving and reading existing comments, use the Inklayer MCP server's tools.`;

const MAX_OUTLINE = 20_000;

const selector = { type: "string", description: 'A Playwright selector: CSS, text=Save, or role=button[name="Save"]' };

export function reviewTools(api: Api, browser: ReviewBrowser): Tool[] {
  const shot = async (fullPage = false): Promise<Content> =>
    image(await browser.page().screenshot({ type: "jpeg", quality: 70, fullPage }));
  const where = () => text(`Now on ${browser.page().url()}${browser.recording ? " (recording)" : ""}`);

  return [
    {
      name: "list_projects",
      description: "The Inklayer projects you can see, and whether you can comment in them. Comments go in one.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      run: async () => {
        const projects = await api.json<LiveProject[]>("GET", "/api/live/projects");
        return [
          text(
            projects
              .map(
                (p) =>
                  `${p.name} (${p.organizationName}), ${p.myRole}${p.canComment ? "" : ", can't comment"}: ${p.id}`,
              )
              .join("\n") || "No projects.",
          ),
        ];
      },
    },
    {
      name: "open_page",
      description: "Open a page in the review browser (one tab, its own profile). Returns a screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          width: { type: "number", description: "Window width in CSS pixels (default 1280)" },
          height: { type: "number", description: "Window height (default 800)" },
        },
        required: ["url"],
      },
      run: async (a) => {
        const width = Number(a.width) || 0;
        const height = Number(a.height) || 0;
        const page = await browser.open(String(a.url), width && height ? { width, height } : undefined);
        return [text(`${await page.title()}: ${page.url()}`), await shot()];
      },
    },
    {
      name: "page_outline",
      description:
        "The open page's accessibility tree as text (roles, names, text): use it to find elements and write selectors.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      run: async () => {
        const outline = await browser.page().locator("body").ariaSnapshot();
        return [text(outline.length > MAX_OUTLINE ? `${outline.slice(0, MAX_OUTLINE)}\n… (cut)` : outline)];
      },
    },
    {
      name: "screenshot",
      description: "A screenshot of the open page: the window, or the whole page.",
      inputSchema: { type: "object", properties: { full_page: { type: "boolean" } } },
      readOnly: true,
      run: async (a) => [where(), await shot(a.full_page === true)],
    },
    {
      name: "click",
      description: "Click an element.",
      inputSchema: { type: "object", properties: { selector }, required: ["selector"] },
      run: async (a) => {
        await browser.page().locator(String(a.selector)).first().click({ timeout: 10_000 });
        await settle(browser);
        return [where()];
      },
    },
    {
      name: "fill",
      description: "Type text into a field, replacing what's there.",
      inputSchema: {
        type: "object",
        properties: { selector, text: { type: "string" } },
        required: ["selector", "text"],
      },
      run: async (a) => {
        await browser.page().locator(String(a.selector)).first().fill(String(a.text), { timeout: 10_000 });
        return [where()];
      },
    },
    {
      name: "press",
      description: "Press a key or shortcut (Enter, Tab, Escape, Control+A…), in the focused element.",
      inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      run: async (a) => {
        await browser.page().keyboard.press(String(a.key));
        await settle(browser);
        return [where()];
      },
    },
    {
      name: "scroll",
      description: "Scroll an element into view, or the page by some pixels (positive is down).",
      inputSchema: { type: "object", properties: { selector, by: { type: "number" } } },
      run: async (a) => {
        const page = browser.page();
        if (a.selector) await page.locator(String(a.selector)).first().scrollIntoViewIfNeeded({ timeout: 10_000 });
        else await page.mouse.wheel(0, Number(a.by) || 600);
        return [where()];
      },
    },
    {
      name: "start_recording",
      description:
        "Start recording the tab (the page reloads, staying signed in). Do the steps, then stop_recording; the next comment gets the video. Keep it under a minute.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        await browser.startRecording();
        return [text("Recording. Do the steps, then stop_recording.")];
      },
    },
    {
      name: "stop_recording",
      description: "Stop recording. The video is attached to the next comment.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const recording = await browser.stopRecording();
        return [text(`Recorded ${recording.seconds}s. The next comment gets it.`)];
      },
    },
    {
      name: "comment",
      description:
        "Leave an Inklayer comment on an element of the open page, as the signed-in person, with a screenshot of it, the page's details (console errors, failed requests) and the last recording.",
      inputSchema: {
        type: "object",
        properties: {
          selector,
          body: { type: "string", description: "The comment: what's wrong or wanted, steps, expected and actual." },
          project_id: {
            type: "string",
            description: "Needed when you can comment in several projects (list_projects).",
          },
          mark: {
            type: "string",
            enum: ["element", "pin"],
            description: "Outline the element (default) or pin a point in it",
          },
          screenshot: { type: "boolean", description: "Attach a screenshot and page details (default true)" },
          attach_recording: { type: "boolean", description: "Attach the last recording (default true)" },
          exact_address: {
            type: "boolean",
            description: "Only for this exact address (with its ?query and #hash), not every version of the page",
          },
        },
        required: ["selector", "body"],
      },
      run: async (a) => {
        const created = await postComment(
          api,
          {
            page: browser.page(),
            console: browser.console,
            network: browser.network,
            takeRecording: () => browser.takeRecording(),
          },
          {
            selector: String(a.selector),
            body: String(a.body ?? ""),
            projectId: a.project_id ? String(a.project_id) : undefined,
            mark: a.mark === "pin" ? "pin" : "element",
            screenshot: a.screenshot !== false,
            attachRecording: a.attach_recording !== false,
            exactAddress: a.exact_address === true,
          },
        );
        const lines = [
          `Comment ${created.id} saved in ${created.project.name} on ${created.pageUrl}.`,
          created.attached.length > 0 ? `Attached: ${created.attached.join(", ")}.` : "",
          ...created.problems.map((p) => `Not attached: ${p}`),
        ];
        return [text(lines.filter(Boolean).join("\n"))];
      },
    },
    {
      name: "close_browser",
      description: "Close the review browser (and drop an unused recording).",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        await browser.close();
        return [text("Closed.")];
      },
    },
  ];
}

/** After a click or key: let the page react (navigate, fetch) before the next step. */
async function settle(browser: ReviewBrowser): Promise<void> {
  await browser
    .page()
    .waitForLoadState("networkidle", { timeout: 3000 })
    .catch(() => undefined);
}
