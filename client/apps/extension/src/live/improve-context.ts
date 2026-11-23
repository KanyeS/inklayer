import { type Anchor, elementHtml, resolveElement } from "@inklayer/overlay";
import type { PageForImprove } from "../lib/claude-helper";

/**
 * What the page says around a comment, for Improve: Claude names things accurately with it and, when the draft asks
 * for options, suggests some from the page's own words. Only text a visitor can read (titles, headings, the section
 * the comment is on, the element) plus the element's HTML without anything typed into forms; Inklayer's own panel is
 * in a closed shadow root, so it never shows up here. Unit-tested: test/improve-context.test.ts.
 */

const MAX_SECTION = 4000;
const MAX_ELEMENT_TEXT = 3000;
const MAX_HTML = 3000;
const MAX_HEADINGS = 40;
/** A section shorter than this says too little: the context grows to the next enclosing element. */
const MIN_SECTION = 400;

const tidy = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

export function pageForImprove(anchor: Anchor | null | undefined, doc: Document = document): PageForImprove {
  const page: PageForImprove = {
    title: tidy(doc.title) || undefined,
    description: tidy(doc.querySelector('meta[name="description"]')?.getAttribute("content")) || undefined,
    outline: [...doc.querySelectorAll("h1, h2, h3")]
      .map((h) => tidy(h.textContent))
      .filter(Boolean)
      .slice(0, MAX_HEADINGS),
  };
  if (!anchor) return page;
  const element = resolveElement(doc, anchor.element).element;
  if (anchor.text?.exact) page.quote = tidy(anchor.text.exact);
  if (!element) return page;
  page.element = {
    tag: element.localName,
    selector: anchor.element.path.join(" >>> "),
    label: tidy(element.getAttribute("aria-label")) || undefined,
    text: tidy(element.textContent).slice(0, MAX_ELEMENT_TEXT),
    html: elementHtml(element).slice(0, MAX_HTML),
  };
  const section = sectionOf(element);
  if (section) page.section = tidy(section.textContent).slice(0, MAX_SECTION);
  return page;
}

/** The part of the page the element is in: its landmark or list item, else the nearest ancestor with enough text. */
function sectionOf(element: Element): Element | null {
  const landmark = element.closest("section, article, header, footer, aside, nav, form, li, figure, [role=region]");
  let at: Element | null = landmark ?? element.parentElement;
  while (at && at.localName !== "body" && tidy(at.textContent).length < MIN_SECTION) at = at.parentElement;
  return at && at.localName !== "body" && at.localName !== "html" ? at : (landmark ?? element.parentElement);
}
