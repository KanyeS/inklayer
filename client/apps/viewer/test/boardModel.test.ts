import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addArrow,
  addCard,
  COLUMN_GAP,
  COLUMN_HEADER,
  cardsOf,
  LOCAL,
  layoutColumn,
  moveCards,
  readArrows,
  readCards,
  removeCards,
  replaceBoard,
  setColumn,
  summaryMarkdown,
  updateArrow,
} from "../src/boards/boardModel";
import { setText, shiftPosition } from "../src/boards/noteText";

/** Two copies of one board, kept in step like two browsers on the docs hub. */
function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on("update", (u: Uint8Array) => Y.applyUpdate(b, u, "remote"));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "remote" && Y.applyUpdate(a, u, "remote"));
  return { a, b };
}

describe("cards and arrows", () => {
  it("adds, moves and removes cards, in step on both copies", () => {
    const { a, b } = pair();
    const note = addCard(a, { x: 10.4, y: 20.6 }, { type: "note", text: "Hello" });
    const doc = addCard(b, { x: 300, y: 0 }, { type: "doc", docId: "d1" });
    expect(readCards(b).map((c) => c.id)).toEqual([note, doc]);

    const read = readCards(b).find((c) => c.id === note);
    expect(read).toMatchObject({ type: "note", x: 10, y: 21 });
    expect(read?.type === "note" && read.text.toString()).toBe("Hello");

    moveCards(b, [{ id: note, x: 50, y: 60 }]);
    expect(readCards(a).find((c) => c.id === note)).toMatchObject({ x: 50, y: 60 });

    const arrow = addArrow(a, note, doc);
    expect(addArrow(a, doc, note)).toBeNull(); // one arrow between two cards
    expect(addArrow(a, note, note)).toBeNull();
    updateArrow(b, arrow ?? "", { label: "leads to" });
    expect(readArrows(a)).toEqual([{ id: arrow, from: note, to: doc, label: "leads to", color: undefined }]);

    removeCards(a, [doc]);
    expect(readCards(b).map((c) => c.id)).toEqual([note]);
    expect(readArrows(b)).toEqual([]); // the arrow went with the card
  });

  it("leaves out cards it doesn't understand", () => {
    const doc = new Y.Doc();
    const odd = new Y.Map<unknown>();
    odd.set("type", "hologram");
    cardsOf(doc).set("x", odd);
    const broken = new Y.Map<unknown>();
    broken.set("type", "doc"); // no docId
    cardsOf(doc).set("y", broken);
    expect(readCards(doc)).toEqual([]);
  });

  it("two people typing in one note both keep their words", () => {
    const { a, b } = pair();
    const id = addCard(a, { x: 0, y: 0 }, { type: "note", text: "plan" });
    const textOf = (d: Y.Doc) => {
      const card = readCards(d).find((c) => c.id === id);
      if (card?.type !== "note") throw new Error("no note");
      return card.text;
    };
    setText(textOf(a), "the plan");
    setText(textOf(b), "the plan today");
    expect(textOf(a).toString()).toBe("the plan today");
  });
});

describe("columns", () => {
  it("stacks cards dropped into a column, and puts them back on the board when it goes", () => {
    const doc = new Y.Doc();
    const column = addCard(doc, { x: 100, y: 100 }, { type: "column", title: "Ideas" });
    const first = addCard(doc, { x: 0, y: 0 }, { type: "note" });
    const second = addCard(doc, { x: 0, y: 0 }, { type: "note" });
    const heights = new Map([
      [first, 80],
      [second, 50],
    ]);
    setColumn(doc, second, column, { x: 120, y: 300 }, heights);
    setColumn(doc, first, column, { x: 120, y: 120 }, heights); // dropped above the other

    const cards = new Map(readCards(doc).map((c) => [c.id, c]));
    expect(cards.get(first)).toMatchObject({ parent: column, x: COLUMN_GAP, y: COLUMN_HEADER });
    expect(cards.get(second)).toMatchObject({ parent: column, y: COLUMN_HEADER + 80 + COLUMN_GAP });

    // Out again: back on the board where it was dropped, and the column closes the gap.
    setColumn(doc, first, null, { x: 700, y: 40 }, heights);
    layoutColumn(doc, column, heights);
    const after = new Map(readCards(doc).map((c) => [c.id, c]));
    expect(after.get(first)).toMatchObject({ x: 700, y: 40, parent: undefined });
    expect(after.get(second)).toMatchObject({ y: COLUMN_HEADER });

    removeCards(doc, [column]);
    const left = readCards(doc).find((c) => c.id === second);
    expect(left).toMatchObject({ parent: undefined, x: 100 + COLUMN_GAP, y: 100 + COLUMN_HEADER });
  });
});

describe("the summary the server indexes", () => {
  it("links the docs on the board and keeps the text of notes, columns and labels, top to bottom", () => {
    const doc = new Y.Doc();
    const roadmap = addCard(doc, { x: 0, y: 500 }, { type: "doc", docId: "d1" });
    addCard(doc, { x: 0, y: 0 }, { type: "note", text: "Ship the beta #launch" });
    const spec = addCard(doc, { x: 0, y: 200 }, { type: "doc", docId: "d2" });
    addCard(doc, { x: 0, y: 900 }, { type: "doc", docId: "gone" });
    addCard(doc, { x: 0, y: 50 }, { type: "link", url: "https://example.com/", title: "Example [site]" });
    updateArrow(doc, addArrow(doc, spec, roadmap) ?? "", { label: "feeds" });

    const docs = new Map([
      ["d1", { id: "d1", folder: "Plans", title: "Roadmap" }],
      ["d2", { id: "d2", folder: "", title: "Spec" }],
    ]);
    expect(summaryMarkdown(doc, docs)).toBe(
      [
        "- [[Spec]]\n- [[Plans/Roadmap]]",
        "Ship the beta #launch",
        "[Example site](https://example.com/)",
        "feeds",
      ].join("\n\n"),
    );
  });
});

describe("carets in a shared note", () => {
  it("stay on the same words when someone else types before them", () => {
    expect(shiftPosition(5, [{ insert: "abc" }])).toBe(8);
    expect(shiftPosition(5, [{ retain: 6 }, { insert: "abc" }])).toBe(5);
    expect(shiftPosition(5, [{ retain: 1 }, { delete: 2 }])).toBe(3);
    expect(shiftPosition(5, [{ retain: 3 }, { delete: 10 }])).toBe(3);
  });
});

describe("restoring a saved version", () => {
  it("puts the cards and arrows back as they were, for everyone, as one step", () => {
    const { a, b } = pair();
    const note = addCard(a, { x: 0, y: 0 }, { type: "note", text: "first draft" });
    const doc = addCard(a, { x: 300, y: 0 }, { type: "doc", docId: "d1" });
    addArrow(a, note, doc);
    const saved = new Y.Doc();
    Y.applyUpdate(saved, Y.encodeStateAsUpdate(a));

    // Later: the note is rewritten and moved, the doc removed, a column added.
    const later = readCards(a).find((c) => c.id === note);
    if (later?.type === "note") setText(later.text, "second draft");
    moveCards(a, [{ id: note, x: 500, y: 500 }]);
    removeCards(a, [doc]);
    addCard(a, { x: 0, y: 0 }, { type: "column" });

    const undo = new Y.UndoManager([cardsOf(a)], { trackedOrigins: new Set([LOCAL]) });
    replaceBoard(a, saved);
    const restored = readCards(b);
    expect(restored.map((c) => c.id).sort()).toEqual([note, doc].sort());
    const back = restored.find((c) => c.id === note);
    expect(back).toMatchObject({ x: 0, y: 0 });
    expect(back?.type === "note" && back.text.toString()).toBe("first draft");
    expect(readArrows(b)).toHaveLength(1);

    undo.undo(); // one step back to how it was before restoring
    expect(readCards(a).some((c) => c.type === "column")).toBe(true);
  });
});

describe("boards the server changed", () => {
  /**
   * Made with YDotNet (yrs) the way the AI tools write cards (server: Features/Docs/BoardEditor.cs): a column, a note in it
   * with Yjs text, a doc card, and an arrow. The browser must read them like its own.
   */
  const FROM_SERVER =
    "AR+hsp6LnPTTCgAnAQVjYXJkcwNjb2wBKAChsp6LnPTTCgAEdHlwZQF3BmNvbHVtbigAobKei5z00woAAXgBfQAoAKGynouc9NMKAAF5AX0AKAChsp6LnPTTCgABdwF9rAQoAKGynouc9NMKAAFoAX2QBigAobKei5z00woAAXoBfQEoAKGynouc9NMKAAV0aXRsZQF3BVBsYW5zJwEFY2FyZHMEbm90ZQEoAKGynouc9NMKCAR0eXBlAXcEbm90ZSgAobKei5z00woIAXgBfQwoAKGynouc9NMKCAF5AX0sKAChsp6LnPTTCggBdwF9lAQoAKGynouc9NMKCAFoAX24ASgAobKei5z00woIAXoBfQIoAKGynouc9NMKCAZwYXJlbnQBdwNjb2woAKGynouc9NMKCAVjb2xvcgF3ByNmZWYzYzcnAKGynouc9NMKCAR0ZXh0AgQAobKei5z00woRDlNoaXAg8J+RiyBiZXRhJwEFY2FyZHMDZG9jASgAobKei5z00woeBHR5cGUBdwNkb2MoAKGynouc9NMKHgF4AX2QBigAobKei5z00woeAXkBfQAoAKGynouc9NMKHgF3AX2YBCgAobKei5z00woeAWgBfbQCKAChsp6LnPTTCh4BegF9AygAobKei5z00woeBWRvY0lkAXcCZDEnAQZhcnJvd3MCYTEBKAChsp6LnPTTCiYEZnJvbQF3BG5vdGUoAKGynouc9NMKJgJ0bwF3A2RvYygAobKei5z00womBWxhYmVsAXcFZmVlZHMA";

  it("reads cards and arrows written on the server", () => {
    const doc = new Y.Doc();
    Y.applyUpdate(
      doc,
      Uint8Array.from(atob(FROM_SERVER), (c) => c.charCodeAt(0)),
    );
    const cards = new Map(readCards(doc).map((c) => [c.id, c]));
    expect(cards.get("col")).toMatchObject({ type: "column", title: "Plans", w: 300, h: 400 });
    const note = cards.get("note");
    expect(note).toMatchObject({ type: "note", parent: "col", x: 12, y: 44, color: "#fef3c7" });
    expect(note?.type === "note" && note.text.toString()).toBe("Ship 👋 beta");
    expect(cards.get("doc")).toMatchObject({ type: "doc", docId: "d1", x: 400 });
    expect(readArrows(doc)).toEqual([{ id: "a1", from: "note", to: "doc", label: "feeds", color: undefined }]);

    // And typing in the server's note works like any other.
    if (note?.type === "note") setText(note.text, "Ship 👋 the beta");
    expect(note?.type === "note" && note.text.toString()).toBe("Ship 👋 the beta");
  });
});
