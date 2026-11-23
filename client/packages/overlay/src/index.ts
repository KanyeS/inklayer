export {
  anchorFor,
  cssEscape,
  describeElement,
  describeRange,
  documentBox,
  innerOrigin,
  isStableId,
  normaliseText,
  resolveElement,
  resolveRange,
  scopedSelectorPath,
  uniqueSelector,
  xpathFor,
} from "./anchoring";
export { BubbleLayer, type BubblePosition } from "./bubbles";
export {
  type CommentPart,
  commentParts,
  commentToOpen,
  decodeMentions,
  encodeMentions,
  MENTION_PATTERN,
  type MentionPerson,
  mentionParts,
  openOnPageUrl,
} from "./commentLinks";
export {
  type CursorPosition,
  cursorPositionAt,
  findCursorElement,
  placeCursor,
  selectionAnchor,
} from "./cursors";
export {
  type Child,
  copyText,
  followColorScheme,
  h,
  keepTyping,
  lineIcon,
  nothing,
  type Props,
  shadowTokens,
  stopPropagation,
} from "./dom";
export { fromFraction, toFraction } from "./geometry";
export { Overlay, type OverlayOptions } from "./overlay";
export { browserOf, elementHtml, osOf, type Rect, screenshotArea } from "./pageDetails";
export { initials, type PresencePeerView, safeColor } from "./people";
export { PresenceLayer } from "./presence";
export * from "./types";
