import { getSettings } from "./settings";

/**
 * The local Claude helper (native-host/): a native messaging host that rewrites comment drafts with the Claude Code CLI
 * signed in on this computer, so it runs on the person's own Claude subscription and nothing reaches the server until
 * they save. Opt-in: needs the optional nativeMessaging permission, the claudeImprove setting and the helper installed.
 */

export const HOST = "com.inklayer.claude";
export const NATIVE_MESSAGING: chrome.permissions.Permissions = { permissions: ["nativeMessaging"] };
/** How people install it, shown in the popup. */
export const INSTALL_COMMAND = "node client/apps/extension/native-host/install.mjs";

/** The CLI takes a few seconds to start; the helper itself gives up after a minute. */
const IMPROVE_TIMEOUT_MS = 90_000;
const PING_TIMEOUT_MS = 20_000;
/** The last ping's result, so pages know whether to show the button without starting the helper each time. */
const READY_KEY = "claudeHelperReady";

export const MAX_IMPROVE_TEXT = 10_000;
export const MAX_ELEMENT_TEXT = 2_000;

export interface ImproveRequest {
  text: string;
  url?: string;
  selector?: string;
  elementText?: string;
}

export type HelperStatus =
  | { enabled: boolean; permission: boolean; ready: true; claude: string }
  | { enabled: boolean; permission: boolean; ready: false; error: string | null };

type HostReply = { ok: true; text?: string; version?: string; claude?: string } | { ok: false; error: string };

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
  if (/not found|forbidden|exited|failed to start/i.test(message))
    return `The Claude helper isn't installed on this computer. Run: ${INSTALL_COMMAND}`;
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

/** Asks Claude to rewrite a comment draft; resolves with the new text. */
export async function improveDraft(request: ImproveRequest): Promise<string> {
  if (!(await helperEnabled())) throw new Error("Improving comments with Claude is turned off (popup → Settings).");
  const text = request.text.slice(0, MAX_IMPROVE_TEXT);
  if (!text.trim()) throw new Error("Write something first.");
  const reply = await sendToHost(
    {
      type: "improve",
      text,
      url: request.url,
      selector: request.selector?.slice(0, MAX_ELEMENT_TEXT),
      elementText: request.elementText?.slice(0, MAX_ELEMENT_TEXT),
    },
    IMPROVE_TIMEOUT_MS,
  );
  if (!reply.ok) throw new Error(reply.error);
  if (!reply.text) throw new Error("Claude returned an empty comment.");
  return reply.text;
}
