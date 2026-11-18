import { serializeDocument, type SerializedPage } from "@inklayer/capture";

// Injected into the page on demand (never declared as an always-on content script).
// It exposes one function, which the background worker calls with chrome.scripting.executeScript.
declare global {
  // eslint-disable-next-line no-var
  var __inklayerCapture: ((maskSelector: string | null) => Promise<SerializedPage>) | undefined;
}

globalThis.__inklayerCapture = (maskSelector) =>
  serializeDocument(document, {
    // chrome.dom.openOrClosedShadowRoot (extensions only) also reaches closed shadow roots.
    getShadowRoot: (el) => chrome.dom?.openOrClosedShadowRoot?.(el as HTMLElement) ?? el.shadowRoot,
    ...(maskSelector ? { maskSelector } : {}),
  });
