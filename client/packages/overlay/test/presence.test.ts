import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { PresenceLayer, commentParts, commentToOpen, cursorPositionAt, initials, openOnPageUrl, placeCursor, selectionAnchor } from "../src";

const HTML = `<main id="article"><p>One</p><p>Two, the paragraph under the pointer.</p><p>Three</p></main>`;
const page = () => new JSDOM(`<!DOCTYPE html><html><body>${HTML}</body></html>`, { pretendToBeVisual: true }).window.document;

/** jsdom has no layout: give an element a box, and the page a width. */
function layout(doc: Document, el: Element, box: { left: number; top: number; width: number; height: number }, pageWidth: number) {
  el.getBoundingClientRect = () => ({ ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box });
  Object.defineProperty(doc.documentElement, "scrollWidth", { configurable: true, value: pageWidth });
}

describe("cursor positions", () => {
  it("follow the element under the pointer onto a screen of a different size", () => {
    const sender = page();
    const target = sender.querySelectorAll("p")[1]!;
    layout(sender, target, { left: 100, top: 200, width: 400, height: 50 }, 1200);
    sender.elementFromPoint = () => target;

    const position = cursorPositionAt(sender, 200, 225);
    expect(position.a).toEqual({ path: ["#article > p:nth-of-type(2)"], tag: "p" });
    expect([position.fx, position.fy]).toEqual([0.25, 0.5]);

    // A narrower window: the paragraph is wider and further down, and the cursor stays at the same place in it.
    const receiver = page();
    layout(receiver, receiver.querySelectorAll("p")[1]!, { left: 10, top: 500, width: 800, height: 100 }, 820);
    expect(placeCursor(receiver, position)).toEqual({ x: 210, y: 550 });
  });

  it("fall back to the document position when the element isn't on the page", () => {
    const sender = page();
    layout(sender, sender.body, { left: 0, top: 0, width: 1000, height: 3000 }, 1000);
    sender.elementFromPoint = () => sender.documentElement;

    const position = cursorPositionAt(sender, 500, 250);
    expect(position.a).toBeUndefined();

    const receiver = new JSDOM(`<!DOCTYPE html><html><body><div>Different page</div></body></html>`).window.document;
    Object.defineProperty(receiver.documentElement, "scrollWidth", { value: 2000 });
    expect(placeCursor(receiver, position)).toEqual({ x: 1000, y: 500 });
  });

  it("skip Inklayer's own elements", () => {
    const doc = page();
    const own = doc.createElement("inklayer-live");
    doc.body.append(own);
    doc.elementFromPoint = () => own;

    expect(cursorPositionAt(doc, 10, 10, (el) => el === own).a).toBeUndefined();
  });
});

describe("selections", () => {
  it("are anchored to their text, and nothing is sent for an empty selection", () => {
    const doc = page();
    expect(selectionAnchor(doc)).toBeNull();

    const text = doc.querySelectorAll("p")[1]!.firstChild!;
    const range = doc.createRange();
    range.setStart(text, 9);
    range.setEnd(text, 18);
    doc.getSelection()!.addRange(range);

    expect(selectionAnchor(doc)?.text?.exact).toBe("paragraph");
  });
});

describe("presence layer", () => {
  it("draws inside its own element and goes away cleanly", () => {
    const doc = page();
    const layer = new PresenceLayer(doc);
    const host = doc.querySelector("inklayer-presence")!;
    expect(layer.owns(host)).toBe(true);

    layer.setPeers([{ id: "a", name: "Ada Lovelace", color: "#A259FF" }]);
    layer.moveCursor("a", { dx: 0.1, dy: 0.1 });
    layer.moveCursor("a", { dx: Number.NaN, dy: 0 } as never); // ignored, not thrown
    layer.removePeer("a");
    layer.destroy();
    expect(doc.querySelector("inklayer-presence")).toBeNull();
  });

  it("shows initials on avatars", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("grace.hopper@example.com")).toBe("GH");
    expect(initials("Linus")).toBe("LI");
  });
});


describe("comment links", () => {
  it("splits a body into text and doc links", () => {
    const parts = commentParts("See [[Spec#Errors|the spec]] and [[Missing]].", [{ text: "Spec", docId: "d1" }, { text: "Missing", docId: null }]);
    expect(parts).toEqual([
      { text: "See " },
      { link: "Spec", shown: "the spec", docId: "d1" },
      { text: " and " },
      { link: "Missing", shown: "Missing", docId: null },
      { text: "." },
    ]);
  });

  it("opens a comment on its page without touching the page's own #hash", () => {
    const id = "0193a6b2-1111-7222-8333-944455556666";
    expect(openOnPageUrl("https://x.test/a", id)).toBe(`https://x.test/a#:~:inklayer=comment:${id}`);
    expect(openOnPageUrl("https://x.test/a#tab=2", id)).toBe(`https://x.test/a#tab=2:~:inklayer=comment:${id}`);
    expect(commentToOpen("https://x.test/a", `https://x.test/a#:~:inklayer=comment:${id}`)).toBe(id);
    expect(commentToOpen(`https://x.test/a#tab=2:~:inklayer=comment:${id}`, undefined)).toBe(id);
    expect(commentToOpen("https://x.test/a#:~:text=hello", undefined)).toBeNull();
  });
});
