import { getSettings } from "./settings";

/**
 * The local Claude helper (claude-plugin/improve): a native messaging host that rewrites comment drafts with the Claude Code CLI
 * signed in on this computer, so it runs on the person's own Claude subscription and nothing reaches the server until
 * they save. Opt-in: needs the optional nativeMessaging permission, the claudeImprove setting and the helper installed.
 */

export const HOST = "com.inklayer.claude";
export const NATIVE_MESSAGING: chrome.permissions.Permissions = { permissions: ["nativeMessaging"] };
/**
 * Installing it with Claude Code: Inklayer's plugin (claude-plugin/ in the repository), which also brings the review
 * helper. The plugin registers the helper with the browsers whenever Claude Code starts. The popup also offers
 * installers to download (helper-installers.ts).
 */
export function pluginCommand(serverUrl: string): string {
  return `claude plugin marketplace add KanyeS/inklayer && claude plugin install inklayer@inklayer --config server_url=${serverUrl}`;
}

/** The page that sets the helper up, opened from the comment box's hint. */
export const HELPER_SETUP_PAGE = "improve.html";
/** Set (in local storage) when the person hides the comment box's hint for good. */
export const IMPROVE_HINT_HIDDEN = "claudeImproveHintHidden";

/** Whether this browser can use the helper at all: builds that ask for nativeMessaging (Chromium's and Firefox's). */
export function helperOffered(): boolean {
  return (chrome.runtime.getManifest().optional_permissions ?? []).includes("nativeMessaging");
}

/** The CLI takes a few seconds to start, and suggestions take a while; the helper itself gives up after 100 seconds. */
const IMPROVE_TIMEOUT_MS = 120_000;
const PING_TIMEOUT_MS = 20_000;
/** The last ping's result, so pages know whether to show the button without starting the helper each time. */
const READY_KEY = "claudeHelperReady";

export const MAX_IMPROVE_TEXT = 10_000;
/**
 * What the page says around the comment, so Claude can name things accurately and, when the draft asks for options
 * ("what alternatives might work?"), suggest some from the page's own content. Gathered by the panel
 * (live/improve-context.ts) and capped here before it leaves for the helper.
 */
export interface PageForImprove {
  title?: string;
  description?: string;
  /** The page's headings (h1 to h3), in order. */
  outline?: string[];
  /** The text of the part of the page the commented element is in. */
  section?: string;
  element?: { tag: string; selector: string; label?: string; text: string; html?: string };
  /** Text the commenter highlighted. */
  quote?: string;
}

/** What a rewrite used, as the helper reports it (older helpers don't). */
export interface ImproveUsage {
  inputTokens: number;
  outputTokens: number;
  /** At API list prices; on a Claude plan it counts towards the plan's limits instead. */
  costUsd: number | null;
  /** Such as claude-sonnet-4-6. */
  model: string | null;
  durationMs: number | null;
}

export interface Improved {
  text: string;
  usage: ImproveUsage | null;
}

export interface ImproveRequest {
  text: string;
  url?: string;
  page?: PageForImprove;
}

const cut = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : undefined;

/** Caps everything a page sends, field by field (the panel caps too; this is what the helper can rely on). */
export function capPage(page: PageForImprove | undefined): PageForImprove | undefined {
  if (!page || typeof page !== "object") return undefined;
  const element = page.element;
  return {
    title: cut(page.title, 300),
    description: cut(page.description, 500),
    outline: Array.isArray(page.outline) ? page.outline.flatMap((h) => cut(h, 200) ?? []).slice(0, 40) : undefined,
    section: cut(page.section, 4000),
    element:
      element && typeof element === "object"
        ? {
            tag: cut(element.tag, 40) ?? "",
            selector: cut(element.selector, 1000) ?? "",
            label: cut(element.label, 300),
            text: cut(element.text, 3000) ?? "",
            html: cut(element.html, 3000),
          }
        : undefined,
    quote: cut(page.quote, 1000),
  };
}

export type HelperStatus =
  | { enabled: boolean; permission: boolean; ready: true; claude: string }
  | { enabled: boolean; permission: boolean; ready: false; error: string | null };

type HostReply =
  | { ok: true; text?: string; usage?: ImproveUsage; version?: string; claude?: string }
  | { ok: false; error: string };

async function hasPermission(): Promise<boolean> {
  return chrome.permissions.contains(NATIVE_MESSAGING);
}

/** Sends one message to the helper. Without the permission, chrome.runtime.sendNativeMessage doesn't exist. */
async function sendToHost(message: object, timeoutMs: number): Promise<HostReply> {
  if (!(await hasPermission()) || !chrome.runtime.sendNativeMessage) {
    throw new Error("Allow Inklayer to use the Claude helper first (popup → Settings).");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Claude took too long to answer.")), timeoutMs);
  });
  try {
    const reply = (await Promise.race([chrome.runtime.sendNativeMessage(HOST, message), timeout])) as HostReply;
    if (!reply || typeof reply !== "object") throw new Error("The Claude helper gave no answer.");
    return reply;
  } catch (error) {
    throw new Error(friendly(error));
  } finally {
    clearTimeout(timer);
  }
}

/** Chrome's errors when the helper isn't installed are cryptic. */
function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found|forbidden|exited|failed to start|no such native application/i.test(message))
    return "The Claude helper isn't set up on this computer yet: see Settings in the Inklayer popup.";
  return message;
}

/** Whether the Improve button should show: turned on, allowed, and the helper answered last time. */
export async function helperEnabled(): Promise<boolean> {
  const [{ claudeImprove }, permission, stored] = await Promise.all([
    getSettings(),
    hasPermission(),
    chrome.storage.local.get(READY_KEY),
  ]);
  return claudeImprove && permission && stored[READY_KEY] === true;
}

/** Checks the helper and Claude Code are installed, and remembers the answer. */
export async function helperStatus(): Promise<HelperStatus> {
  const [{ claudeImprove: enabled }, permission] = await Promise.all([getSettings(), hasPermission()]);
  if (!enabled || !permission) {
    await chrome.storage.local.set({ [READY_KEY]: false });
    const error = enabled ? "Inklayer no longer has permission to use the helper. Turn this off and on again." : null;
    return { enabled, permission, ready: false, error };
  }
  try {
    const reply = await sendToHost({ type: "ping" }, PING_TIMEOUT_MS);
    if (!reply.ok) throw new Error(reply.error);
    await chrome.storage.local.set({ [READY_KEY]: true });
    return { enabled, permission, ready: true, claude: reply.claude ?? "" };
  } catch (error) {
    await chrome.storage.local.set({ [READY_KEY]: false });
    return { enabled, permission, ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Asks Claude to rewrite a comment draft; resolves with the new text and what it used. */
export async function improveDraft(request: ImproveRequest): Promise<Improved> {
  if (!(await helperEnabled())) throw new Error("Improving comments with Claude is turned off (popup → Settings).");
  const text = request.text.slice(0, MAX_IMPROVE_TEXT);
  if (!text.trim()) throw new Error("Write something first.");
  const reply = await sendToHost(
    { type: "improve", text, url: request.url, page: capPage(request.page) },
    IMPROVE_TIMEOUT_MS,
  );
  if (!reply.ok) throw new Error(reply.error);
  if (!reply.text) throw new Error("Claude returned an empty comment.");
  return { text: reply.text, usage: reply.usage ?? null };
}
