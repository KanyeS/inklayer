/** Persistent extension state in chrome.storage.local. Tokens are only readable by the extension itself. */
export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface Settings {
  serverUrl: string | null;
  tokens: Tokens | null;
  lastProjectId: string | null;
  maskSelector: string | null;
}

const DEFAULTS: Settings = { serverUrl: null, tokens: null, lastProjectId: null, maskSelector: null };

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...(stored as Partial<Settings>) };
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}

/** Normalises user input like "inklayer.example.com/" to "https://inklayer.example.com". */
export function normaliseServerUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("The server must use HTTPS (plain HTTP is only allowed for localhost).");
  }
  return url.origin;
}
