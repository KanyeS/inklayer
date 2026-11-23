import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import { CLICKS_FLAG } from "./page/clicks";

/**
 * The browser Claude reviews pages in: Playwright's Chromium, one tab. Keeps the page's recent console errors and
 * failed requests for comments' details, and records the tab on request (a new browser context with video on, carrying
 * the cookies and storage over, so the page stays signed in; clicks show as rings in the video).
 * Sign-ins to the sites being reviewed (cookies and local storage) are kept in a file only the person can read, so
 * they sign in once, in a window of its own (signInToSite), and later sessions start signed in.
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
  /** Where sign-ins to the reviewed sites are kept (Playwright storage state); none kept if null. */
  siteLogins: string | null;
}

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Recordings stop by themselves after this long, like the extension's: the server takes about a minute of video. */
export const MAX_RECORDING_MS = 60_000;
/** How long the sign-in window waits for the person. */
const SIGN_IN_WINDOW_MS = 10 * 60_000;
/** How to install the Chromium that this playwright-core needs. */
export const INSTALL_BROWSER = `npx -y playwright-core@${createRequire(import.meta.url)("playwright-core/package.json").version} install chromium`;

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
  #recording: { started: number; dir: string; poster: Buffer | null; timer: NodeJS.Timeout } | null = null;
  #stopping: Promise<Recording> | null = null;
  /** Set when a recording stopped at the time limit, until someone asks for it. */
  #autoStopped = false;
  /** The last recording, until a comment takes it or a new one starts. */
  #finished: Recording | null = null;

  constructor(options: BrowserOptions) {
    this.#options = options;
  }

  /** Recording, or finishing a recording. */
  get recording(): boolean {
    return this.#recording !== null || this.#stopping !== null;
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
    const page = this.#page ?? (await this.#newContext({ state: await this.#savedLogins() }));
    await page.goto(url, { waitUntil: "load" });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => undefined);
    await this.#saveLogins();
    return page;
  }

  /**
   * Opens a visible window at `url` for the person to sign in to the site, and waits until they close it. The sign-in
   * is kept for this and later sessions. Returns the address the window ended on.
   */
  async signInToSite(url: string): Promise<string> {
    if (this.#recording) throw new Error("Stop recording first.");
    const browser = await launch(false);
    try {
      const context = await browser.newContext({
        viewport: null,
        ...(await this.#currentState().then((state) => (state ? { storageState: state } : {}))),
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "load" });
      let last = page.url();
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) last = frame.url();
      });
      let state = await context.storageState();
      const save = async () => {
        state = await context.storageState().catch(() => state);
      };
      const timer = setInterval(() => void save(), 2000);
      await Promise.race([
        page.waitForEvent("close", { timeout: 0 }),
        new Promise((resolve) => browser.once("disconnected", resolve)),
        new Promise((resolve) => setTimeout(resolve, SIGN_IN_WINDOW_MS)),
      ]);
      clearInterval(timer);
      await save();
      await this.#switchLogins(state, last);
      return last;
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  /** Forgets every sign-in to reviewed sites, here and on disk. */
  async forgetLogins(): Promise<void> {
    if (this.#options.siteLogins) await rm(this.#options.siteLogins, { force: true });
    await this.#switchLogins(null, this.#page?.url() ?? null);
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
    const timer = setTimeout(() => {
      this.#autoStopped = true;
      void this.stopRecording().catch(() => undefined);
    }, MAX_RECORDING_MS);
    timer.unref();
    this.#recording = { started: Date.now(), dir, poster: null, timer };
    this.#autoStopped = false;
    await recorded.goto(url, { waitUntil: "load" });
    this.#recording.poster = await recorded.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
  }

  /** Whether the last recording stopped by itself at the time limit (asked once). */
  takeAutoStopped(): boolean {
    const stopped = this.#autoStopped;
    this.#autoStopped = false;
    return stopped;
  }

  /**
   * Stops recording; the video waits for the next comment. The page carries on, no longer recorded. Closing the
   * recording takes a moment (the video is written then): a second call meanwhile waits for the same one.
   */
  stopRecording(): Promise<Recording> {
    if (this.#stopping) return this.#stopping;
    if (!this.#recording) return Promise.reject(new Error("Not recording: use start_recording first."));
    this.#stopping = this.#stop().finally(() => {
      this.#stopping = null;
    });
    return this.#stopping;
  }

  async #stop(): Promise<Recording> {
    const recording = this.#recording;
    if (!recording || !this.#page || !this.#context) throw new Error("Not recording: use start_recording first.");
    clearTimeout(recording.timer);
    const seconds = Math.round((Date.now() - recording.started) / 1000);
    const page = this.#page;
    const url = page.url();
    const state = await this.#context.storageState();
    const video = page.video();
    await this.#context.close();
    this.#recording = null;
    if (!video) throw new Error("The browser didn't record a video.");
    this.#finished = {
      path: await video.path(),
      seconds,
      poster: recording.poster,
      ...this.#viewport,
    };
    await this.#saveLogins(state);
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
    await this.#saveLogins().catch(() => undefined);
    await this.#browser?.close();
    this.#browser = null;
    this.#context = null;
    this.#page = null;
  }

  async #newContext(o: { dir?: string; state?: StorageState | null }): Promise<Page> {
    this.#browser ??= await launch(this.#options.headless);
    this.#context = await this.#browser.newContext({
      viewport: this.#viewport,
      ...(o.state ? { storageState: o.state } : {}),
      ...(o.dir ? { recordVideo: { dir: o.dir, size: this.#viewport } } : {}),
    });
    // In recordings, clicks show as rings, so people watching see what was pressed.
    if (o.dir) await this.#context.addInitScript(`globalThis[${JSON.stringify(CLICKS_FLAG)}] = true;`);
    await this.#context.addInitScript({ path: this.#options.pageScript });
    this.#page = await this.#context.newPage();
    this.#watch(this.#page);
    return this.#page;
  }

  /** The open page's cookies and storage, else the saved sign-ins. */
  async #currentState(): Promise<StorageState | null> {
    return (await this.#context?.storageState().catch(() => null)) ?? (await this.#savedLogins());
  }

  /** Starts the main tab afresh with these sign-ins (null for none), back at `url`. */
  async #switchLogins(state: StorageState | null, url: string | null): Promise<void> {
    await this.#saveLogins(state);
    if (!this.#page) return;
    await this.#context?.close();
    const page = await this.#newContext({ state });
    if (url && url !== "about:blank") await page.goto(url, { waitUntil: "load" }).catch(() => undefined);
  }

  async #savedLogins(): Promise<StorageState | null> {
    if (!this.#options.siteLogins) return null;
    try {
      return JSON.parse(await readFile(this.#options.siteLogins, "utf8")) as StorageState;
    } catch {
      return null;
    }
  }

  /** Keeps the sign-ins: `state`, or the open page's if not given; null forgets them. Only the person can read the file. */
  async #saveLogins(state?: StorageState | null): Promise<void> {
    const file = this.#options.siteLogins;
    if (!file) return;
    const current = state === undefined ? await this.#context?.storageState().catch(() => undefined) : state;
    if (current === undefined) return;
    if (current === null) {
      await rm(file, { force: true });
      return;
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(current), { mode: 0o600 });
    await chmod(file, 0o600);
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

/** Starts Playwright's Chromium, or says how to install it. */
async function launch(headless: boolean): Promise<Browser> {
  try {
    return await chromium.launch({ headless });
  } catch (error) {
    const first = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    if (!headless && /display|XServer|headed/i.test(first)) {
      throw new Error(
        "There's no screen to show a window on here, so you can't sign in to the site from this session.",
      );
    }
    throw new Error(`Couldn't start Chromium (${first}). Install it with: ${INSTALL_BROWSER}`);
  }
}
