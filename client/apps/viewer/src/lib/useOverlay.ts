import { unwrapOverlayMessage, wrap, type HostMessage, type OverlayMessage } from "@inklayer/overlay";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Connects to the overlay script running inside the snapshot frame.
 * <ul>
 * <li>Incoming messages are accepted only from that frame's window, in Inklayer's envelope format.</li>
 * <li>Outgoing messages use targetOrigin "*". The frame is sandboxed without allow-same-origin, so its origin is opaque
 * and can't be named. It only ever holds Inklayer's own snapshot document, because its links can't navigate.</li>
 * </ul>
 */
export function useOverlay(onMessage: (message: OverlayMessage) => void) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const message = unwrapOverlayMessage(event.data);
      if (!message) return;
      if (message.type === "ready") setReady(true);
      handler.current(message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);

  const send = useCallback((message: HostMessage) => {
    frameRef.current?.contentWindow?.postMessage(wrap(message), "*");
  }, []);

  return { frameRef, ready, send, resetReady: () => setReady(false) };
}
