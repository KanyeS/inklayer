/** Messages between a live tab and the background worker. Shared by both sides. Only types and the port name, so the content script doesn't pull in the SignalR client. */

export const PRESENCE_PORT = "inklayer.presence";

export interface PresencePeer {
  id: string;
  userId: string;
  name: string;
  color: string;
}

/** Content script → background, over the port. */
export type PresenceUp =
  | { t: "join"; url: string }
  | { t: "cursor"; data: unknown }
  | { t: "select"; data: unknown }
  | { t: "idle" };

/** Background → content script, over the port. */
export type PresenceDown =
  | { t: "status"; status: "connecting" | "live" | "offline"; error?: string }
  | { t: "peers"; peers: PresencePeer[] }
  | { t: "peerJoin"; peer: PresencePeer }
  | { t: "peerLeave"; id: string }
  | { t: "cursor" | "select"; id: string; data: unknown }
  | { t: "idle"; id: string };
