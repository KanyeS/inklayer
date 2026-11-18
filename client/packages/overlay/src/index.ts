export * from "./types";
export { Overlay, type OverlayOptions } from "./overlay";
export {
  anchorFor, describeElement, describeRange, resolveElement, resolveRange, uniqueSelector, scopedSelectorPath,
  xpathFor, isStableId, normaliseText, cssEscape,
} from "./anchoring";
export { toFraction, fromFraction } from "./geometry";
export {
  PresenceLayer, cursorPositionAt, selectionAnchor, placeCursor, findCursorElement, initials, type CursorPosition, type PresencePeerView,
} from "./presence";
export { commentParts, openOnPageUrl, commentToOpen, type CommentPart } from "./commentLinks";
