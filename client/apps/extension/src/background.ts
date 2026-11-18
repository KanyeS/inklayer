import { api, type Me, type Project } from "./lib/api";
import { NotSignedInError, redirectUri, signIn, signOut } from "./lib/auth";
import { captureTab, getStatus } from "./lib/capture";
import type { Request, Response, StateResponse } from "./lib/messages";
import { getLiveSites, handleLive, isLiveRequest, stopLive, syncLiveSites, type LiveRequest } from "./lib/live";
import { getSettings, updateSettings } from "./lib/settings";

// Keep the live content script registered for the right sites.
chrome.runtime.onStartup.addListener(() => void syncLiveSites());
chrome.runtime.onInstalled.addListener(() => void syncLiveSites());
chrome.permissions.onAdded.addListener(() => void syncLiveSites());
chrome.permissions.onRemoved.addListener(() => void syncLiveSites());

chrome.runtime.onMessage.addListener((request: Request | LiveRequest, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  // From the live content script on a web page: only live requests, checked against the page's real origin.
  if (sender.tab) {
    if (!isLiveRequest(request)) return false;
    respond(handleLive(request, sender.url), sendResponse);
    return true;
  }

  // From the extension's own pages (the popup).
  if (isLiveRequest(request)) return false;
  respond(handle(request), sendResponse);
  return true; // respond asynchronously
});

function respond(result: Promise<unknown>, sendResponse: (response: Response<unknown>) => void): void {
  result
    .then((value) => sendResponse({ ok: true, value } satisfies Response<unknown>))
    .catch((error: unknown) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      notSignedIn: error instanceof NotSignedInError,
    } satisfies Response<unknown>));
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "state":
      return state();
    case "signIn": {
      const { serverUrl } = await getSettings();
      if (!serverUrl) throw new Error("Set the server address first.");
      await signIn(serverUrl);
      void syncLiveSites();
      return null;
    }
    case "signOut":
      await signOut();
      await stopLive();
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
  if (me) void syncLiveSites();
  return {
    serverUrl: settings.serverUrl,
    signedIn: me !== null,
    liveSites: me ? [...new Set((await getLiveSites()).map((s) => s.origin))] : [],
    me,
    lastProjectId: settings.lastProjectId,
    redirectUri: redirectUri(),
    status: await getStatus(),
  };
}
