import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  commentParts,
  commentToOpen,
  cursorPositionAt,
  decodeMentions,
  encodeMentions,
  initials,
  openOnPageUrl,
  PresenceLayer,
  placeCursor,
  selectionAnchor,
} from "../src";
import { glide, isCursorPosition } from "../src/cursors";
import { avatarPill, cursorElement, realName, safeColor, statusLabel } from "../src/people";

const HTML = `<main id="article"><p>One</p><p>Two, the paragraph under the pointer.</p><p>Three</p></main>`;
const page = () =>
  new JSDOM(`<!DOCTYPE html><html><body>${HTML}</body></html>`, { pretendToBeVisual: true }).window.document;

/** jsdom has no layout: give an element a box, and the page a width. */
function layout(
  doc: Document,
  el: Element,
  box: { left: number; top: number; width: number; height: number },
  pageWidth: number,
) {
  el.getBoundingClientRect = () => ({
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  });
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
    const parts = commentParts("See [[Spec#Errors|the spec]] and [[Missing]].", [
      { text: "Spec", docId: "d1" },
      { text: "Missing", docId: null },
    ]);
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

describe("mentions", () => {
  const ana = { id: "0193a6b2-1111-7222-8333-944455556666", displayName: "Ana", fullName: "Ana Lee" };
  const anaLee = { id: "0193a6b2-1111-7222-8333-944455557777", displayName: "Ana Lee", fullName: "Ana Lee" };

  it("shows <@id> as names, next to doc links", () => {
    expect(commentParts(`Ask <@${ana.id}> about [[Spec]]`, [{ text: "Spec", docId: "d1" }], [ana])).toEqual([
      { text: "Ask " },
      { mention: "Ana", userId: ana.id, fullName: "Ana Lee" },
      { text: " about " },
      { link: "Spec", shown: "Spec", docId: "d1" },
    ]);
  });

  it("round-trips between what people type and what's stored", () => {
    const picked = new Map<string, string>();
    const shown = decodeMentions(`<@${ana.id}> and <@${anaLee.id}>`, [ana, anaLee], picked);
    expect(shown).toBe("@Ana and @Ana Lee");
    expect(encodeMentions(shown, picked)).toBe(`<@${ana.id}> and <@${anaLee.id}>`);
  });
});

describe("people and cursors (helpers)", () => {
  it("names people by their chosen name, with the real one when it differs", () => {
    expect(realName({ id: "1", name: "Ana", color: "#000000", fullName: "Ana Lee" })).toBe("Ana (Ana Lee)");
    expect(realName({ id: "1", name: "Ana", color: "#000000", fullName: "Ana" })).toBe("Ana");
    expect(realName({ id: "1", name: "Ana", color: "#000000" })).toBe("Ana");
  });

  it("lets only plain hex colours through", () => {
    expect(safeColor("#12abEF")).toBe("#12abEF");
    expect(safeColor("red; background:url(x)")).toBe("#7c3aed");
  });

  it("says how live presence is", () => {
    expect(statusLabel("live", 0)).toBe("Live · just you");
    expect(statusLabel("live", 2)).toBe("Live");
    expect(statusLabel("connecting", 0)).toBe("Connecting…");
    expect(statusLabel("offline", 0)).toBe("Offline");
    expect(statusLabel("offline", 0, "Reconnecting in 5s")).toBe("Reconnecting in 5s");
  });

  it("shows five faces, then +N", () => {
    const peers = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, name: `P${i}`, color: "#112233" }));
    const pill = avatarPill(document, { status: "live", text: "" }, peers, () => undefined);
    expect(pill.querySelectorAll("button.face")).toHaveLength(5);
    expect(pill.querySelector(".more")?.textContent).toBe("+2");
    expect(pill.querySelector(".more")?.getAttribute("title")).toBe("P5, P6");
  });

  it("builds the cursor arrow without parsing markup", () => {
    const { cursor, label } = cursorElement(document, { id: "1", name: "Ana", color: "#112233" });
    expect(cursor.querySelector("svg path")?.getAttribute("fill")).toBe("var(--c)");
    expect(label.textContent).toBe("Ana");
    expect(cursor.hidden).toBe(true);
  });

  it("accepts only well-formed positions from others", () => {
    expect(isCursorPosition({ dx: 0.1, dy: 0.2 })).toBe(true);
    expect(isCursorPosition({ dx: 0.1, dy: 0.2, a: { path: ["main"], tag: "main" }, fx: 0.5, fy: 0.5 })).toBe(true);
    expect(isCursorPosition({ dx: 0.1, dy: 0.2, a: { path: ["main"], tag: "main" } })).toBe(false);
    expect(isCursorPosition({ dx: "x", dy: 0 })).toBe(false);
    expect(isCursorPosition(null)).toBe(false);
  });

  it("glides towards the target, jumping when it's new or far", () => {
    expect(glide(null, { x: 10, y: 10 })).toEqual({ at: { x: 10, y: 10 }, moving: false });
    expect(glide({ x: 0, y: 0 }, { x: 5000, y: 0 })).toEqual({ at: { x: 5000, y: 0 }, moving: false });
    const step = glide({ x: 0, y: 0 }, { x: 100, y: 0 });
    expect(step.moving).toBe(true);
    expect(step.at.x).toBeCloseTo(35);
    expect(glide({ x: 99.8, y: 0 }, { x: 100, y: 0 })).toEqual({ at: { x: 100, y: 0 }, moving: false });
  });
});
