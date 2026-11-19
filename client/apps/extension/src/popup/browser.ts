import type { StateResponse } from "@/lib/messages";

/** What the popup asks of the browser, and which screen it shows. */

/** Every site: to show comments on pages, and (as "<all_urls>", which browsers require for it) to take screenshots. */
export const SITE_ACCESS: chrome.permissions.Permissions = { origins: ["<all_urls>"] };

/**
 * Asks for site access (or confirms it's granted, without prompting). Firefox only allows permission requests directly
 * inside a click, so call this before any other await in a click handler.
 */
export function requestSiteAccess(): Promise<boolean> {
  return chrome.permissions.request(SITE_ACCESS);
}

/** The tab the popup was opened over, if it has an id. */
export async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** Opens a page of the web app in a new tab and closes the popup. */
export async function openInNewTab(url: string): Promise<void> {
  await chrome.tabs.create({ url });
  window.close();
}

/** Screens the user moves to by hand; otherwise the screen follows the sign-in state. */
export type Choice = "auto" | "setup" | "settings";

export type Screen = "setup" | "settings" | "signIn" | "signedIn";

/** The screen to show: setup until there's a server, then sign in, then the main screen (or what the user picked). */
export function screenFor(state: Pick<StateResponse, "serverUrl" | "signedIn" | "me">, choice: Choice): Screen {
  if (choice === "setup" || !state.serverUrl) return "setup";
  if (choice === "settings") return "settings";
  return state.signedIn && state.me ? "signedIn" : "signIn";
}
