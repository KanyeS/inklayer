import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";

/**
 * The browser Claude reviews pages in: Playwright's Chromium, one tab, its own profile for this session. Keeps the
 * page's recent console errors and failed requests for comments' details, and records the tab on request (a new
 * browser context with video on, carrying the cookies and storage over, so the page stays signed in).
 */

export interface LogEntry {
  level: string;
  message: string;
  at: string;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  ms: number;
  at: string;
}

export interface Recording {
  /** The WebM file. */
  path: string;
  seconds: number;
  /** A still from the start, for places the video can't play. */
  poster: Buffer | null;
  width: number;
  height: number;
}

export interface BrowserOptions {
  /** page.js, put into every page. */
  pageScript: string;
  headless: boolean;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
/** Most console and network entries kept (the server keeps 20). */
const MAX_ENTRIES = 20;
const MAX_MESSAGE = 500;

export class ReviewBrowser {
  readonly #options: BrowserOptions;
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #viewport = DEFAULT_VIEWPORT;
  #console: LogEntry[] = [];
  #network: NetworkEntry[] = [];
  #recording: { started: number; dir: string; poster: Buffer | null } | null = null;
  /** The last recording, until a comment takes it or a new one starts. */
  #finished: Recording | null = null;

  constructor(options: BrowserOptions) {
    this.#options = options;
  }

  get recording(): boolean {
    return this.#recording !== null;
  }

  /** The finished recording waiting for a comment, if any. */
  get finishedRecording(): Recording | null {
    return this.#finished;
  }

  get console(): LogEntry[] {
    return [...this.#console];
  }

  get network(): NetworkEntry[] {
    return [...this.#network];
  }

  /** The open page; fails if none is open yet. */
  page(): Page {
    if (!this.#page) throw new Error("No page is open: use open_page first.");
    return this.#page;
  }

  async open(url: string, viewport?: { width: number; height: number }): Promise<Page> {
    if (viewport && (viewport.width !== this.#viewport.width || viewport.height !== this.#viewport.height)) {
      this.#viewport = viewport;
      await this.#page?.setViewportSize(viewport);
    }
    const page = this.#page ?? (await this.#newContext(null));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    return page;
  }

  /** Starts recording the tab, from the page that's open now (reloaded in a recording context). */
  async startRecording(): Promise<void> {
    if (this.#recording) throw new Error("Already recording: use stop_recording first.");
    const page = this.page();
    const url = page.url();
    const state = await this.#context?.storageState();
    await this.discardRecording();
    const dir = await mkdtemp(join(tmpdir(), "inklayer-review-"));
    await this.#context?.close();
    const recorded = await this.#newContext({ dir, state });
    this.#recording = { started: Date.now(), dir, poster: null };
    await recorded.goto(url, { waitUntil: "load" });
    this.#recording.poster = await recorded.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
  }

  /** Stops recording; the video waits for the next comment. The page carries on, no longer recorded. */
  async stopRecording(): Promise<Recording> {
    const recording = this.#recording;
    if (!recording || !this.#page || !this.#context) throw new Error("Not recording: use start_recording first.");
    const page = this.#page;
    const url = page.url();
    const state = await this.#context.storageState();
    const video = page.video();
    await this.#context.close();
    this.#recording = null;
    if (!video) throw new Error("The browser didn't record a video.");
    this.#finished = {
      path: await video.path(),
      seconds: Math.round((Date.now() - recording.started) / 1000),
      poster: recording.poster,
      ...this.#viewport,
    };
    const next = await this.#newContext({ state });
    await next.goto(url, { waitUntil: "load" }).catch(() => undefined);
    return this.#finished;
  }

  /** Hands the finished recording to a comment (the caller deletes it when done). */
  takeRecording(): Recording | null {
    const taken = this.#finished;
    this.#finished = null;
    return taken;
  }

  async discardRecording(): Promise<void> {
    const old = this.takeRecording();
    if (old) await deleteRecording(old);
  }

  async close(): Promise<void> {
    if (this.#recording) await this.stopRecording().catch(() => undefined);
    await this.discardRecording();
    await this.#browser?.close();
    this.#browser = null;
    this.#context = null;
    this.#page = null;
  }

  async #newContext(
    o: { dir?: string; state?: Awaited<ReturnType<BrowserContext["storageState"]>> } | null,
  ): Promise<Page> {
    this.#browser ??= await chromium.launch({ headless: this.#options.headless }).catch((error: unknown) => {
      throw new Error(
        `Couldn't start Chromium (${error instanceof Error ? error.message.split("\n")[0] : error}). Install it with: npx playwright-core@1.65.1 install chromium`,
      );
    });
    this.#context = await this.#browser.newContext({
      viewport: this.#viewport,
      ...(o?.state ? { storageState: o.state } : {}),
      ...(o?.dir ? { recordVideo: { dir: o.dir, size: this.#viewport } } : {}),
    });
    await this.#context.addInitScript({ path: this.#options.pageScript });
    this.#page = await this.#context.newPage();
    this.#watch(this.#page);
    return this.#page;
  }

  /** Keeps the page's recent console errors and warnings, and failed requests, since it last loaded. */
  #watch(page: Page): void {
    const now = () => new Date().toISOString();
    const keep = <T>(list: T[], entry: T) => {
      list.push(entry);
      if (list.length > MAX_ENTRIES) list.shift();
    };
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      this.#console = [];
      this.#network = [];
    });
    page.on("console", (message) => {
      const level = message.type();
      if (level !== "error" && level !== "warning") return;
      keep(this.#console, {
        level: level === "warning" ? "warn" : level,
        message: message.text().slice(0, MAX_MESSAGE),
        at: now(),
      });
    });
    page.on("pageerror", (error) =>
      keep(this.#console, { level: "error", message: error.message.slice(0, MAX_MESSAGE), at: now() }),
    );
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const timing = response.request().timing();
      keep(this.#network, {
        method: response.request().method(),
        url: response.url().slice(0, 2000),
        status: response.status(),
        ms: Math.max(0, Math.round(timing.responseEnd)),
        at: now(),
      });
    });
    page.on("requestfailed", (request) =>
      keep(this.#network, { method: request.method(), url: request.url().slice(0, 2000), status: 0, ms: 0, at: now() }),
    );
  }
}

export async function deleteRecording(recording: Recording): Promise<void> {
  await rm(join(recording.path, ".."), { recursive: true, force: true }).catch(() => undefined);
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
