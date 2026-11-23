import { api, type Me } from "./lib/api";
import { NotSignedInError, redirectUri, signIn, signOut } from "./lib/auth";
import { helperStatus } from "./lib/claude-helper";
import { handleLive, isLiveRequest, type LiveRequest, openLiveInTab, stopLive, syncLiveScript } from "./lib/live";
import { isOwnPage, type Request, type Response, type StateResponse } from "./lib/messages";
import { inbox, markRead, startNotifications } from "./lib/notifications";
import { acceptPort, forgetTab, isPresenceOn, PRESENCE_PORT, setPresence, stopPresence } from "./lib/presence";
import { isRecorderMessage, type RecorderMessage } from "./lib/recorder-protocol";
import { handleRecorder, recordingDone, watchRecorderTabs } from "./lib/recorder-session";
import type { RecordingDone, RecordingSignal } from "./lib/recordings";
import { getSettings, updateSettings } from "./lib/settings";

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
// Recordings that carry on across page changes: stopped when their tab closes.
watchRecorderTabs();

chrome.runtime.onMessage.addListener(
  (request: Request | LiveRequest | { type: "presence.status" }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;

    // From the recorder's pages (extension pages: the bar on the page, the window, the sidebar, the hidden recorder).
    if (
      ["recorder.html", "offscreen.html", "sidebar.html"].some((page) =>
        sender.url?.startsWith(chrome.runtime.getURL(page)),
      )
    ) {
      const message = request as unknown as RecorderMessage | RecordingSignal | RecordingDone;
      if (message.type === "recording.draw") {
        const tabId = message.tabId ?? sender.tab?.id;
        if (tabId !== undefined)
          void chrome.tabs.sendMessage(tabId, { type: "inklayer.recordingDraw" }).catch(() => undefined);
        return false;
      }
      if (message.type === "recording.done") {
        const tabId = message.tabId ?? sender.tab?.id;
        if (tabId === undefined) return false;
        respond(
          recordingDone(tabId, message.recordingId, message.seconds).then(() => null),
          sendResponse,
        );
        return true;
      }
      if (isRecorderMessage(message)) {
        respond(handleRecorder(message, sender.tab?.id, sender.tab?.windowId), sendResponse);
        return true;
      }
    }

    // From the live content script on a web page: only live requests, checked against the page's real origin. The
    // extension's own pages can be open in a tab too (the Improve setup page): they're answered like the popup below.
    if (sender.tab && !isOwnPage(sender.url, chrome.runtime.getURL(""))) {
      // After a reload: was presence on in this tab?
      if (request.type === "presence.status") {
        respond(isPresenceOn(sender.tab.id ?? -1), sendResponse);
        return true;
      }
      if (!isLiveRequest(request)) return false;
      respond(handleLive(request, sender.url, sender.tab?.windowId, sender.tab?.id), sendResponse);
      return true;
    }

    // From the extension's own pages (the popup, the Improve setup page).
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
    case "claudeStatus":
      return helperStatus();
    case "setClaudeImprove":
      await updateSettings({ claudeImprove: request.on });
      return helperStatus();
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
