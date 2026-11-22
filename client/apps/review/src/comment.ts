import { readFile } from "node:fs/promises";
import { browserOf, osOf, screenshotArea } from "@inklayer/overlay";
import type { Page } from "playwright-core";
import type { Api, LiveProject } from "./api";
import { deleteRecording, fileSize, type LogEntry, type NetworkEntry, type Recording } from "./browser";
import { type Described, PAGE_GLOBAL } from "./page/describe";

/**
 * Leaving a comment on the open page, as the extension does: the comment anchored to an element, then (best effort) a
 * screenshot around it, the page's details, and the recording. Unit-tested: test/comment.test.ts.
 */

export interface CommentInput {
  /** A Playwright selector for the element: CSS, text=…, role=button[name="Save"]… */
  selector: string;
  body: string;
  projectId?: string;
  /** Outline the element (the default), or a pin at a point in it (fractions of its box, centre by default). */
  mark?: "element" | "pin";
  point?: { x: number; y: number };
  /** Attach a screenshot of the element and the page's details (default true). */
  screenshot?: boolean;
  /** Attach the finished recording (default true, when there is one). */
  attachRecording?: boolean;
  /** The comment is for this exact address (with its ?query and #hash), not every version of the page. */
  exactAddress?: boolean;
  color?: string;
}

export interface CommentSources {
  page: Page;
  console: LogEntry[];
  network: NetworkEntry[];
  takeRecording(): Recording | null;
}

export interface Created {
  id: string;
  project: LiveProject;
  pageUrl: string;
  attached: string[];
  /** What couldn't be attached, and why (the comment is saved anyway). */
  problems: string[];
}

/** The extension's first colour (amber). */
export const DEFAULT_COLOR = "#f59e0b";
const MAX_SCREENSHOT_BYTES = 600 * 1024;
const MAX_VIDEO_BYTES = 40 * 1024 * 1024;

/** The project to comment in: the one asked for, or the only one the person can comment in. */
export function chooseProject(projects: LiveProject[], projectId?: string): LiveProject {
  const commentable = projects.filter((p) => p.canComment);
  if (projectId) {
    const found = projects.find((p) => p.id === projectId);
    if (!found) throw new Error(`No project ${projectId}. Use list_projects.`);
    if (!found.canComment) throw new Error(`You can't comment in ${found.name} (you're a ${found.myRole}).`);
    return found;
  }
  const [only] = commentable;
  if (commentable.length === 1 && only) return only;
  if (commentable.length === 0)
    throw new Error("You can't comment in any project: ask an admin for the Commenter role.");
  throw new Error(
    `Say which project with project_id: ${commentable.map((p) => `${p.name} (${p.organizationName}): ${p.id}`).join("; ")}`,
  );
}

/** What the server needs to place the comment. */
export function annotationBody(input: CommentInput, described: Described, url: string) {
  const pin = input.mark === "pin";
  const address = new URL(url);
  return {
    url,
    kind: pin ? "Pin" : "Element",
    body: input.body,
    color: input.color ?? DEFAULT_COLOR,
    anchor: described.anchor,
    geometry: pin ? { kind: "Pin", point: input.point ?? { x: 0.5, y: 0.5 } } : { kind: "Element" },
    viewportWidth: described.viewport.width,
    includeQuery: input.exactAddress === true && address.search.length > 1,
    includeHash: input.exactAddress === true && address.hash.length > 1,
  };
}

/** The page's details, in the shape the server keeps them. */
export function pageContext(described: Described, sources: Pick<CommentSources, "console" | "network">) {
  return {
    browser: browserOf(described.userAgent),
    os: osOf(described.userAgent),
    userAgent: described.userAgent,
    viewportWidth: described.viewport.width,
    viewportHeight: described.viewport.height,
    devicePixelRatio: described.devicePixelRatio,
    zoom: 1,
    selector: described.selector,
    elementHtml: described.elementHtml,
    console: sources.console,
    network: sources.network,
    timeZone: described.timeZone,
    utcOffsetMinutes: described.utcOffsetMinutes,
  };
}

export async function describeElement(page: Page, selector: string): Promise<Described> {
  const element = page.locator(selector).first();
  try {
    await element.scrollIntoViewIfNeeded({ timeout: 5000 });
  } catch {
    throw new Error(`Nothing on the page matches ${selector}. Use page_outline to find the element.`);
  }
  return element.evaluate(
    (el, name) => (window as unknown as Record<string, { describe(el: Element): unknown }>)[name]?.describe(el),
    PAGE_GLOBAL,
  ) as Promise<Described>;
}

export async function postComment(api: Api, sources: CommentSources, input: CommentInput): Promise<Created> {
  if (!input.body.trim()) throw new Error("Write the comment's text in body.");
  const { page } = sources;
  const described = await describeElement(page, input.selector);
  if (!described) throw new Error("The page script isn't loaded: reload the page with open_page.");
  const project = chooseProject(await api.json<LiveProject[]>("GET", "/api/live/projects"), input.projectId);
  const pageUrl = page.url();
  const created = await api.json<{ id: string }>(
    "POST",
    `/api/projects/${encodeURIComponent(project.id)}/live/annotations`,
    annotationBody(input, described, pageUrl),
  );
  const id = encodeURIComponent(created.id);
  const result: Created = { id: created.id, project, pageUrl, attached: [], problems: [] };
  const attempt = async (what: string, work: () => Promise<void>) => {
    try {
      await work();
      result.attached.push(what);
    } catch (error) {
      result.problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (input.screenshot !== false) {
    await attempt("screenshot", async () => {
      const area = screenshotArea(described.rect, described.viewport);
      let image = await page.screenshot({ type: "jpeg", quality: 80, clip: area });
      if (image.length > MAX_SCREENSHOT_BYTES) image = await page.screenshot({ type: "jpeg", quality: 50, clip: area });
      const scale = described.devicePixelRatio;
      await api.put(
        `/api/annotations/${id}/screenshot?width=${Math.round(area.width * scale)}&height=${Math.round(area.height * scale)}`,
        image,
        "image/jpeg",
      );
    });
    await attempt("page details", () =>
      api.json("PUT", `/api/annotations/${id}/context`, pageContext(described, sources)),
    );
  }

  const recording = input.attachRecording === false ? null : sources.takeRecording();
  if (recording) {
    await attempt(`recording (${recording.seconds}s)`, async () => {
      if ((await fileSize(recording.path)) > MAX_VIDEO_BYTES) throw new Error("it's over 40 MB; record a shorter one.");
      await api.put(
        `/api/annotations/${id}/media/video?width=${recording.width}&height=${recording.height}`,
        await readFile(recording.path),
        "video/webm",
      );
      if (recording.poster) await api.put(`/api/annotations/${id}/media/thumbnail`, recording.poster, "image/jpeg");
    });
    await deleteRecording(recording);
  }
  return result;
}
