export * from "./types";
export { Overlay, type OverlayOptions } from "./overlay";
export { wrap, unwrapHostMessage, unwrapOverlayMessage } from "./bridge";
export {
  anchorFor, describeElement, describeRange, resolveElement, resolveRange, uniqueSelector, scopedSelectorPath,
  xpathFor, isStableId, normaliseText, cssEscape,
} from "./anchoring";
export { toFraction, fromFraction } from "./geometry";
