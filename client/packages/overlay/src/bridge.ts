import { PROTOCOL, PROTOCOL_VERSION, type Envelope, type HostMessage, type OverlayMessage } from "./types";

const HOST_TYPES = new Set<HostMessage["type"]>(["setAnnotations", "setTool", "select", "clearDraft", "scrollTo"]);
const OVERLAY_TYPES = new Set<OverlayMessage["type"]>(["ready", "draft", "selected", "anchors"]);

export function wrap<T>(message: T): Envelope<T> {
  return { protocol: PROTOCOL, version: PROTOCOL_VERSION, message };
}

/** Unwraps a message from the viewer, or returns null for anything that isn't one. */
export function unwrapHostMessage(data: unknown): HostMessage | null {
  return unwrap(data, HOST_TYPES) as HostMessage | null;
}

/** Unwraps a message from the overlay, or returns null for anything that isn't one. */
export function unwrapOverlayMessage(data: unknown): OverlayMessage | null {
  return unwrap(data, OVERLAY_TYPES) as OverlayMessage | null;
}

function unwrap(data: unknown, types: Set<string>): { type: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const envelope = data as Partial<Envelope<{ type?: unknown }>>;
  if (envelope.protocol !== PROTOCOL || envelope.version !== PROTOCOL_VERSION) return null;
  const message = envelope.message;
  if (typeof message !== "object" || message === null || typeof message.type !== "string" || !types.has(message.type)) return null;
  return message as { type: string };
}
