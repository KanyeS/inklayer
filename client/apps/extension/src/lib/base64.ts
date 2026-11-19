/** Bytes per String.fromCharCode call: large enough to be quick, small enough not to overflow the call stack. */
const CHUNK = 0x8000;

/** Encodes bytes as base64 (to send binary data to a content script, which only takes JSON-able messages). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}
