import { serializeDocument, type SerializedPage } from "@inklayer/capture";

// Injected into the page on demand (never declared as an always-on content script).
// It exposes one function, which the background worker calls with chrome.scripting.executeScript.
declare global {
  // eslint-disable-next-line no-var
  var __inklayerCapture: ((maskSelector: string | null) => Promise<SerializedPage>) | undefined;
}

/** Firefox gives content scripts this method on elements; Chrome has chrome.dom.openOrClosedShadowRoot instead. */
type FirefoxElement = Element & { openOrClosedShadowRoot?: () => ShadowRoot | null };

/** Also reaches closed shadow roots, which only extensions can see. Falls back to open roots only. */
function getShadowRoot(el: Element): ShadowRoot | null {
  if (typeof chrome.dom?.openOrClosedShadowRoot === "function") return chrome.dom.openOrClosedShadowRoot(el as HTMLElement) ?? null;
  const firefox = (el as FirefoxElement).openOrClosedShadowRoot;
  if (typeof firefox === "function") return firefox.call(el);
  return el.shadowRoot;
}

globalThis.__inklayerCapture = (maskSelector) =>
  serializeDocument(document, {
    getShadowRoot,
    ...(maskSelector ? { maskSelector } : {}),
  });
