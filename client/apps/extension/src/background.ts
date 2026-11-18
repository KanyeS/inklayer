import { api, type Me, type Project } from "./lib/api";
import { NotSignedInError, redirectUri, signIn, signOut } from "./lib/auth";
import { captureTab, getStatus } from "./lib/capture";
import type { Request, Response, StateResponse } from "./lib/messages";
import { getSettings, updateSettings } from "./lib/settings";

chrome.runtime.onMessage.addListener((request: Request, sender, sendResponse) => {
  // Only the extension's own pages may talk to the worker.
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  handle(request)
    .then((value) => sendResponse({ ok: true, value } satisfies Response<unknown>))
    .catch((error: unknown) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      notSignedIn: error instanceof NotSignedInError,
    } satisfies Response<unknown>));
  return true; // respond asynchronously
});

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "state":
      return state();
    case "signIn": {
      const { serverUrl } = await getSettings();
      if (!serverUrl) throw new Error("Set the server address first.");
      await signIn(serverUrl);
      return null;
    }
    case "signOut":
      await signOut();
      return null;
    case "projects":
      return api<Project[]>(`/api/orgs/${request.organizationId}/projects`);
    case "capture": {
      const tab = await chrome.tabs.get(request.tabId);
      const { maskSelector } = await getSettings();
      await updateSettings({ lastProjectId: request.projectId });
      // Runs to completion in the background; the popup follows progress through chrome.storage.session.
      void captureTab(tab, request.projectId, maskSelector).catch(() => undefined);
      return null;
    }
  }
}

async function state(): Promise<StateResponse> {
  const settings = await getSettings();
  let me: Me | null = null;
  if (settings.serverUrl && settings.tokens) {
    try {
      me = await api<Me>("/api/me");
    } catch (error) {
      if (!(error instanceof NotSignedInError)) throw error;
    }
  }
  return {
    serverUrl: settings.serverUrl,
    signedIn: me !== null,
    me,
    lastProjectId: settings.lastProjectId,
    redirectUri: redirectUri(),
    status: await getStatus(),
  };
}
