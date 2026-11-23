/**
 * The panel's settings remembered in the extension's storage, the same on every site: read once when the panel
 * starts, then followed as other tabs change them (moving or pinning the panel, the unread count).
 */

const STORED_KEYS = [
  "bubblesOpen",
  "attachContext",
  "panelPosition",
  "panelPinned",
  "unreadCount",
  "fullPage",
  "productMenu",
];

export type StoredSettings = Record<string, unknown>;
export type SettingChanges = Record<string, chrome.storage.StorageChange>;

export function watchSettings(
  restore: (stored: StoredSettings) => void,
  follow: (changes: SettingChanges) => void,
): void {
  void chrome.storage.local
    .get(STORED_KEYS)
    .then(restore)
    .catch(() => undefined);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") follow(changes);
  });
}
