import { type Anchor, anchorFor, elementHtml, type Rect } from "@inklayer/overlay";

/**
 * Runs in the page (page.js): describes an element the way the extension does when someone comments on it, so the
 * comment's mark finds the element again for everyone, plus the page details that go with a comment.
 * Unit-tested: test/describe.test.ts.
 */

export interface Described {
  anchor: Anchor;
  /** The anchor's CSS path, for the comment's details. */
  selector: string;
  elementHtml: string;
  /** Where the element is in the window, in CSS pixels. */
  rect: Rect;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  userAgent: string;
  timeZone: string;
  utcOffsetMinutes: number;
}

export function describe(el: Element): Described {
  const anchor = anchorFor(el);
  const box = el.getBoundingClientRect();
  return {
    anchor,
    selector: anchor.element.path.join(" >>> "),
    elementHtml: elementHtml(el),
    rect: { x: box.left, y: box.top, width: box.width, height: box.height },
    viewport: { width: innerWidth, height: innerHeight },
    devicePixelRatio,
    userAgent: navigator.userAgent,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -new Date().getTimezoneOffset(),
  };
}

/** What page.js puts on window, for the helper to call. */
export const PAGE_GLOBAL = "__inklayerReview";
