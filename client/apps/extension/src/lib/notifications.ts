import type { InboxResponse, NotificationResponse } from "@inklayer/api";
import { api } from "./api";
import { getSettings } from "./settings";

/**
 * Notifications, background side: the unread count on the toolbar icon, refreshed every minute, and the recent ones for
 * the popup and the in-page panel. (A tab where live cursors are on shows LIVE on the icon instead; the panel's bell still counts.)
 */

export type InboxItem = NotificationResponse;

export interface Inbox extends InboxResponse {
  /** The Inklayer server, for opening a notification in the web app. */
  serverUrl: string;
}

const ALARM = "inklayer-notifications";

export function startNotifications(): void {
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM) void refreshBadge().catch(() => undefined);
  });
  void refreshBadge().catch(() => undefined);
}

export async function inbox(limit = 8): Promise<Inbox> {
  const { serverUrl } = await getSettings();
  const result = await api.get("/api/notifications", { params: { query: { limit } } });
  await showCount(result.unread);
  return { ...result, serverUrl: new URL(serverUrl!).origin };
}

export async function markRead(ids: string[] | null): Promise<void> {
  await api.post("/api/notifications/read", { body: ids ? { ids } : { all: true } });
  await refreshBadge();
}

async function refreshBadge(): Promise<void> {
  const { serverUrl, tokens } = await getSettings();
  if (!serverUrl || !tokens) return showCount(0);
  const { unread } = await api.get("/api/notifications", { params: { query: { limit: 1 } } });
  await showCount(unread);
}

async function showCount(unread: number): Promise<void> {
  // For the in-page panel's bell, which follows this rather than asking the server itself.
  await chrome.storage.local.set({ unreadCount: unread });
  await chrome.action.setBadgeText({ text: unread > 0 ? (unread > 99 ? "99+" : String(unread)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#6d28d9" });
}
