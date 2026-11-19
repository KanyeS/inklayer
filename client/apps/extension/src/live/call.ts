import type { LiveRequest } from "../lib/live";
import type { Response } from "../lib/messages";

/**
 * Sends a request to the background worker and returns its answer. The page never talks to the server itself: the
 * background checks every request against this page's origin and adds the token.
 * Throws an Error whose message can be shown to the user as-is.
 */
export async function call<T>(request: LiveRequest): Promise<T> {
  let response: Response<T> | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as Response<T> | undefined;
  } catch {
    throw new Error("Inklayer was updated or restarted. Reload this page to keep commenting.");
  }
  if (!response) throw new Error("Inklayer didn't answer. Reload this page.");
  if (!response.ok) {
    throw new Error(
      response.notSignedIn ? "You're signed out of Inklayer. Sign in from the toolbar button." : response.error,
    );
  }
  return response.value;
}

/** The message of something caught, for showing to the user. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Saves a setting in the extension's local storage, ignoring failures (the setting just isn't remembered). */
export function remember(values: Record<string, unknown>): void {
  void chrome.storage.local.set(values).catch(() => undefined);
}
