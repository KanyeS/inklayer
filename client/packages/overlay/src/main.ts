import { unwrapHostMessage, wrap } from "./bridge";
import { Overlay } from "./overlay";
import type { OverlayMessage } from "./types";

/**
 * Entry point of the script the server injects into captured pages (admitted by a CSP nonce).
 * It talks only to the parent frame, and only to the app origin the server named in data-app-origin.
 */
(() => {
  const script = Document.prototype.querySelector.call(document, "script[data-app-origin]") as HTMLScriptElement | null;
  const appOrigin = script?.getAttribute("data-app-origin");
  if (!appOrigin || window.parent === window) return;

  const send = (message: OverlayMessage) => window.parent.postMessage(wrap(message), appOrigin);
  const overlay = new Overlay(document, send);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== appOrigin) return;
    const message = unwrapHostMessage(event.data);
    if (message) overlay.handle(message);
  });

  const root = document.documentElement;
  send({ type: "ready", width: root.scrollWidth, height: root.scrollHeight });
})();
