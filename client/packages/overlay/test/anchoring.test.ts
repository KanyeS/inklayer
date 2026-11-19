import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  anchorFor,
  describeElement,
  describeRange,
  isStableId,
  resolveElement,
  resolveRange,
  scopedSelectorPath,
  uniqueSelector,
  xpathFor,
} from "../src";

const page = (html: string) => new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`).window.document;

describe("selectors", () => {
  it("prefers stable ids and test attributes", () => {
    const doc = page(`<main id="content"><button data-testid="buy">Buy</button><p>x</p></main>`);

    expect(uniqueSelector(doc.getElementById("content")!, doc)).toBe("#content");
    expect(uniqueSelector(doc.querySelector("button")!, doc)).toBe('button[data-testid="buy"]');
    expect(uniqueSelector(doc.querySelector("p")!, doc)).toBe("#content > p");
  });

  it("ignores framework-generated ids", () => {
    expect(isStableId("checkout-form")).toBe(true);
    for (const id of [":r1:", "ember123", "react-select-3-input", "a1b2c3d4e5f6", "item_12345", "radix-:R1:"]) {
      expect(isStableId(id)).toBe(false);
    }
  });

  it("uses nth-of-type only where siblings share a tag, and the result is unique", () => {
    const doc = page(`<ul><li>One</li><li>Two</li><li><span>Three</span></li></ul>`);
    const span = doc.querySelector("li:nth-child(3) > span")!;

    const selector = uniqueSelector(span, doc);

    expect(selector).toBe("html > body > ul > li:nth-of-type(3) > span");
    expect(doc.querySelectorAll(selector)).toHaveLength(1);
  });

  it("builds a path through shadow roots", () => {
    const doc = page(`<x-card id="card"></x-card>`);
    const shadow = doc.getElementById("card")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div class="body"><h2>Title</h2></div>`;
    const h2 = shadow.querySelector("h2")!;

    const path = scopedSelectorPath(h2);

    expect(path).toEqual(["#card", "div > h2"]);
    expect(describeElement(h2).xpath).toBeNull();
    expect(resolveElement(doc, describeElement(h2))).toEqual({ element: h2, quality: "exact" });
  });

  it("produces absolute XPaths", () => {
    const doc = page(`<div></div><div><p>a</p><p>b</p></div>`);

    expect(xpathFor(doc.querySelectorAll("p")[1]!)).toBe("/html/body/div[2]/p[2]");
  });
});

describe("resolveElement", () => {
  it("finds the same element exactly when the page is unchanged", () => {
    const doc = page(`<section><h1>Pricing</h1></section>`);
    const anchor = describeElement(doc.querySelector("h1")!);

    expect(resolveElement(doc, anchor)).toEqual({ element: doc.querySelector("h1"), quality: "exact" });
  });

  it("falls back to XPath when the CSS path no longer matches", () => {
    const original = page(`<div id="hero"><h1>Pricing</h1></div>`);
    const anchor = describeElement(original.querySelector("h1")!);
    const changed = page(`<div id="banner"><h1>Pricing</h1></div>`); // id renamed

    const { element, quality } = resolveElement(changed, anchor);

    expect(element?.textContent).toBe("Pricing");
    expect(quality).toBe("fallback");
  });

  it("falls back to unique text when the structure changed", () => {
    const original = page(`<div><div><p>Free shipping over $50</p></div></div>`);
    const anchor = describeElement(original.querySelector("p")!);
    const changed = page(`<header>New banner</header><section><p>Other</p><p>Free shipping over $50</p></section>`);

    const { element, quality } = resolveElement(changed, anchor);

    expect(element?.textContent).toBe("Free shipping over $50");
    expect(quality).toBe("fallback");
  });

  it("reports orphaned annotations when the element is gone", () => {
    const anchor = describeElement(page(`<p id="promo">Summer sale</p>`).querySelector("p")!);

    expect(resolveElement(page(`<p>Something else</p>`), anchor)).toEqual({ element: null, quality: "orphaned" });
  });
});

describe("text anchors", () => {
  const select = (doc: Document, root: Element, text: string, occurrence = 0) => {
    const walker = doc.createTreeWalker(root, 4);
    let seen = 0;
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      let i = n.data.indexOf(text);
      while (i >= 0) {
        if (seen++ === occurrence) {
          const range = doc.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + text.length);
          return range;
        }
        i = n.data.indexOf(text, i + 1);
      }
    }
    throw new Error("not found");
  };

  it("round-trips a selection across element boundaries", () => {
    const doc = page(`<article><p>The <b>quick brown</b> fox jumps.</p></article>`);
    const article = doc.querySelector("article")!;
    const range = doc.createRange();
    range.setStart(article.querySelector("b")!.firstChild!, 6); // "brown"
    range.setEnd(article.querySelector("p")!.lastChild!, 4); // " fox"

    const anchor = describeRange(range, article)!;
    const resolved = resolveRange(article, anchor);

    expect(anchor.exact).toBe("brown fox");
    expect(resolved.quality).toBe("exact");
    expect(resolved.range!.toString()).toBe("brown fox");
  });

  it("re-finds moved text using its surrounding context", () => {
    const original = page(`<article><p>Price: $10. Tax: $10. Total: $20.</p></article>`);
    const root = original.querySelector("article")!;
    const anchor = describeRange(select(original, root, "$10", 1), root)!; // the Tax one

    const changed = page(`<article><p>Note: prices updated. Price: $10. Tax: $10. Total: $20.</p></article>`);
    const resolved = resolveRange(changed.querySelector("article")!, anchor);

    expect(resolved.quality).toBe("fallback");
    const r = resolved.range!;
    expect(r.toString()).toBe("$10");
    expect((r.startContainer as Text).data.slice(r.startOffset - 5, r.startOffset)).toBe("Tax: ");
  });

  it("is orphaned when the text no longer exists", () => {
    const original = page(`<article><p>Limited offer</p></article>`);
    const root = original.querySelector("article")!;
    const anchor = describeRange(select(original, root, "Limited"), root)!;

    expect(resolveRange(page(`<article><p>Gone</p></article>`).querySelector("article")!, anchor).quality).toBe(
      "orphaned",
    );
  });

  it("anchorFor combines the element and the text", () => {
    const doc = page(`<p id="intro">Hello world</p>`);
    const p = doc.getElementById("intro")!;

    const anchor = anchorFor(p, select(doc, p, "world"));

    expect(anchor.element.path).toEqual(["#intro"]);
    expect(anchor.text).toMatchObject({ exact: "world", prefix: "Hello ", suffix: "", start: 6, end: 11 });
  });
});
