import { api, type Me } from "./lib/api";
import { NotSignedInError, redirectUri, signIn, signOut } from "./lib/auth";
import { handleLive, isLiveRequest, type LiveRequest, openLiveInTab, stopLive, syncLiveScript } from "./lib/live";
import type { Request, Response, StateResponse } from "./lib/messages";
import { inbox, markRead, startNotifications } from "./lib/notifications";
import { acceptPort, forgetTab, isPresenceOn, PRESENCE_PORT, setPresence, stopPresence } from "./lib/presence";
import type { RecordingDone } from "./lib/recordings";
import { getSettings } from "./lib/settings";

// The unread count on the toolbar icon.
startNotifications();

// Keep the live content script registered while signed in with site access.
chrome.runtime.onStartup.addListener(() => void syncLiveScript());
chrome.runtime.onInstalled.addListener(() => void syncLiveScript());
chrome.permissions.onAdded.addListener(() => void syncLiveScript());
chrome.permissions.onRemoved.addListener(() => void syncLiveScript());

// Live presence: a port from each tab where the user turned it on.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PRESENCE_PORT) void acceptPort(port);
  else port.disconnect();
});
chrome.tabs.onRemoved.addListener((tabId) => void forgetTab(tabId));

chrome.runtime.onMessage.addListener(
  (request: Request | LiveRequest | { type: "presence.status" }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;

    // From the recording window (an extension page in its own window): a recording is ready, for the page it's from.
    if (
      sender.url?.startsWith(chrome.runtime.getURL("recorder.html")) &&
      (request as { type?: string }).type === "recording.done"
    ) {
      const done = request as unknown as RecordingDone;
      respond(
        chrome.tabs
          .sendMessage(done.tabId, {
            type: "inklayer.recording",
            recordingId: done.recordingId,
            seconds: done.seconds,
            size: done.size,
          })
          .then(() => null),
        sendResponse,
      );
      return true;
    }

    // From the live content script on a web page: only live requests, checked against the page's real origin.
    if (sender.tab) {
      // After a reload: was presence on in this tab?
      if (request.type === "presence.status") {
        respond(isPresenceOn(sender.tab.id ?? -1), sendResponse);
        return true;
      }
      if (!isLiveRequest(request)) return false;
      respond(handleLive(request, sender.url, sender.tab?.windowId, sender.tab?.id), sendResponse);
      return true;
    }

    // From the extension's own pages (the popup).
    if (isLiveRequest(request) || request.type === "presence.status") return false;
    respond(handle(request), sendResponse);
    return true; // respond asynchronously
  },
);

function respond(result: Promise<unknown>, sendResponse: (response: Response<unknown>) => void): void {
  result
    .then((value) => sendResponse({ ok: true, value } satisfies Response<unknown>))
    .catch((error: unknown) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        notSignedIn: error instanceof NotSignedInError,
      } satisfies Response<unknown>),
    );
}

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "state":
      return state();
    case "signIn": {
      const { serverUrl } = await getSettings();
      if (!serverUrl) throw new Error("Set the server address first.");
      await signIn(serverUrl);
      await syncLiveScript();
      return null;
    }
    case "signOut":
      await signOut();
      await stopPresence();
      await stopLive();
      return null;
    case "openLive":
      await openLiveInTab(request.tabId, request.view);
      return null;
    case "notifications":
      return inbox();
    case "notificationsRead":
      await markRead(request.ids ?? null);
      return null;
    case "presenceState":
      return isPresenceOn(request.tabId);
    case "setPresence":
      await setPresence(request.tabId, request.on);
      return null;
    case "connectedApps":
      return (await api.get("/api/me/apps")).length;
  }
}

async function state(): Promise<StateResponse> {
  const settings = await getSettings();
  let me: Me | null = null;
  if (settings.serverUrl && settings.tokens) {
    try {
      me = await api.get("/api/me");
    } catch (error) {
      if (!(error instanceof NotSignedInError)) throw error;
    }
  }
  if (me) void syncLiveScript();
  return {
    serverUrl: settings.serverUrl,
    signedIn: me !== null,
    me,
    redirectUri: redirectUri(),
  };
}
