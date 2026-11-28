/**
 * A board's Yjs document: its cards and arrows. The server only relays the bytes; everything about the shape is here.
 *
 * - `cards`: card id → Y.Map of the card's fields. A note's text is a Y.Text, so two people can type in one note at once.
 *   Positions are on the board, or inside a column when `parent` is set (then relative to the column).
 * - `arrows`: arrow id → Y.Map. Arrows people drew. Arrows for [[links]] between docs aren't stored: the board draws them
 *   from the docs' own links, so they're always current.
 *
 * Every change goes through the functions here, in one transaction each, so it's one step to undo and one update to send.
 */

import * as Y from "yjs";

export type CardType = "doc" | "note" | "image" | "link" | "column";

interface CardBase {
  id: string;
  type: CardType;
  x: number;
  y: number;
  w: number;
  /** Notes, docs and links grow with their content; their stored height is a minimum. */
  h: number;
  /** Stacking order: higher is on top. */
  z: number;
  /** The column the card is in, if any. */
  parent?: string;
  color?: string;
}

export interface DocCard extends CardBase {
  type: "doc";
  docId: string;
  /** Shows the live editor instead of a preview. */
  expanded?: boolean;
}

export interface NoteCard extends CardBase {
  type: "note";
  text: Y.Text;
}

export interface ImageCard extends CardBase {
  type: "image";
  mediaId: string;
  alt?: string;
}

export interface LinkCard extends CardBase {
  type: "link";
  url: string;
  title?: string;
  description?: string;
  /** The page's preview picture, as the page gives it. */
  image?: string;
}

export interface ColumnCard extends CardBase {
  type: "column";
  title: string;
}

export type Card = DocCard | NoteCard | ImageCard | LinkCard | ColumnCard;

export interface Arrow {
  id: string;
  from: string;
  to: string;
  label?: string;
  color?: string;
}

/** Sizes new cards start at. */
export const CARD_SIZES: Record<CardType, { w: number; h: number }> = {
  doc: { w: 280, h: 180 },
  note: { w: 220, h: 120 },
  image: { w: 260, h: 200 },
  link: { w: 280, h: 120 },
  column: { w: 300, h: 400 },
};

/** An expanded doc card: big enough to write in. */
export const EXPANDED_DOC_SIZE = { w: 560, h: 520 };

/** Space between cards stacked in a column, and around them. */
export const COLUMN_GAP = 12;
export const COLUMN_HEADER = 44;

/** The note colours to pick from (light backgrounds; text stays the theme's). */
export const NOTE_COLORS = ["#fef3c7", "#dcfce7", "#dbeafe", "#fce7f3", "#ede9fe", "#f1f5f9"];

/** Undoable changes are made with this origin; others' arrive with the hub's. */
export const LOCAL = Symbol("board-local");

export function cardsOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("cards");
}

export function arrowsOf(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap("arrows");
}

const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** One card as plain data. Unknown or broken entries (from a newer version, say) are left out. */
export function readCard(id: string, map: Y.Map<unknown>): Card | null {
  const type = map.get("type");
  const size = CARD_SIZES[type as CardType];
  if (!size) return null;
  const base = {
    id,
    x: num(map.get("x")),
    y: num(map.get("y")),
    w: num(map.get("w"), size.w),
    h: num(map.get("h"), size.h),
    z: num(map.get("z")),
    parent: str(map.get("parent")),
    color: str(map.get("color")),
  };
  switch (type) {
    case "doc": {
      const docId = str(map.get("docId"));
      return docId ? { ...base, type, docId, expanded: map.get("expanded") === true } : null;
    }
    case "note": {
      const text = map.get("text");
      return text instanceof Y.Text ? { ...base, type, text } : null;
    }
    case "image": {
      const mediaId = str(map.get("mediaId"));
      return mediaId ? { ...base, type, mediaId, alt: str(map.get("alt")) } : null;
    }
    case "link": {
      const url = str(map.get("url"));
      return url
        ? {
            ...base,
            type,
            url,
            title: str(map.get("title")),
            description: str(map.get("description")),
            image: str(map.get("image")),
          }
        : null;
    }
    case "column":
      return { ...base, type, title: str(map.get("title")) ?? "" };
    default:
      return null;
  }
}

/** Every card, bottom first. */
export function readCards(doc: Y.Doc): Card[] {
  const cards: Card[] = [];
  for (const [id, map] of cardsOf(doc)) {
    const card = readCard(id, map);
    if (card) cards.push(card);
  }
  // Columns under everything, so cards dragged over them stay visible.
  return cards.sort((a, b) => (a.type === "column" ? 0 : 1) - (b.type === "column" ? 0 : 1) || a.z - b.z);
}

export function readArrows(doc: Y.Doc): Arrow[] {
  const arrows: Arrow[] = [];
  for (const [id, map] of arrowsOf(doc)) {
    const from = str(map.get("from"));
    const to = str(map.get("to"));
    if (from && to) arrows.push({ id, from, to, label: str(map.get("label")), color: str(map.get("color")) });
  }
  return arrows;
}

export function newId(): string {
  return crypto.randomUUID();
}

function topZ(doc: Y.Doc): number {
  let top = 0;
  for (const map of cardsOf(doc).values()) top = Math.max(top, num(map.get("z")));
  return top + 1;
}

type NewCard =
  | { type: "doc"; docId: string }
  | { type: "note"; text?: string; color?: string }
  | { type: "image"; mediaId: string; alt?: string; w?: number; h?: number }
  | { type: "link"; url: string; title?: string; description?: string; image?: string }
  | { type: "column"; title?: string };

/** Adds a card with its top-left corner at (x, y), on top of the others. Returns its id. */
export function addCard(doc: Y.Doc, at: { x: number; y: number }, card: NewCard): string {
  const id = newId();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    const size = CARD_SIZES[card.type];
    map.set("type", card.type);
    map.set("x", Math.round(at.x));
    map.set("y", Math.round(at.y));
    map.set("w", "w" in card && card.w ? card.w : size.w);
    map.set("h", "h" in card && card.h ? card.h : size.h);
    map.set("z", topZ(doc));
    switch (card.type) {
      case "doc":
        map.set("docId", card.docId);
        break;
      case "note": {
        const text = new Y.Text();
        if (card.text) text.insert(0, card.text);
        map.set("text", text);
        map.set("color", card.color ?? NOTE_COLORS[0]);
        break;
      }
      case "image":
        map.set("mediaId", card.mediaId);
        if (card.alt) map.set("alt", card.alt);
        break;
      case "link":
        map.set("url", card.url);
        for (const key of ["title", "description", "image"] as const) if (card[key]) map.set(key, card[key]);
        break;
      case "column":
        map.set("title", card.title ?? "Column");
        break;
    }
    cardsOf(doc).set(id, map);
  }, LOCAL);
  return id;
}

/** Changes some of a card's fields. `undefined` removes a field. */
export function updateCard(
  doc: Y.Doc,
  id: string,
  fields: Partial<
    Record<
      "x" | "y" | "w" | "h" | "z" | "parent" | "color" | "expanded" | "title" | "description" | "image" | "alt",
      unknown
    >
  >,
): void {
  const map = cardsOf(doc).get(id);
  if (!map) return;
  doc.transact(() => {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) map.delete(key);
      else if (map.get(key) !== value) map.set(key, typeof value === "number" ? Math.round(value) : value);
    }
  }, LOCAL);
}

/** Moves cards (each to its own position), in one step. */
export function moveCards(doc: Y.Doc, moves: { id: string; x: number; y: number }[]): void {
  if (moves.length === 0) return;
  doc.transact(() => {
    for (const { id, x, y } of moves) {
      const map = cardsOf(doc).get(id);
      if (!map) continue;
      if (map.get("x") !== Math.round(x)) map.set("x", Math.round(x));
      if (map.get("y") !== Math.round(y)) map.set("y", Math.round(y));
    }
  }, LOCAL);
}

/** Brings a card to the top. */
export function raiseCard(doc: Y.Doc, id: string): void {
  const map = cardsOf(doc).get(id);
  if (!map) return;
  const z = topZ(doc);
  if (num(map.get("z")) < z - 1) doc.transact(() => map.set("z", z), LOCAL);
}

/**
 * Removes cards and the arrows to and from them. A removed column leaves its cards on the board, where they were.
 */
export function removeCards(doc: Y.Doc, ids: Iterable<string>): void {
  const gone = new Set(ids);
  if (gone.size === 0) return;
  const cards = cardsOf(doc);
  doc.transact(() => {
    for (const [id, map] of cards) {
      const parent = str(map.get("parent"));
      if (parent && gone.has(parent) && !gone.has(id)) {
        const column = cards.get(parent);
        map.set("x", num(map.get("x")) + num(column?.get("x")));
        map.set("y", num(map.get("y")) + num(column?.get("y")));
        map.delete("parent");
      }
    }
    for (const id of gone) cards.delete(id);
    for (const [id, arrow] of arrowsOf(doc)) {
      if (gone.has(str(arrow.get("from")) ?? "") || gone.has(str(arrow.get("to")) ?? "")) arrowsOf(doc).delete(id);
    }
  }, LOCAL);
}

/** Draws an arrow between two cards, unless one is already there (either way round). Returns its id. */
export function addArrow(doc: Y.Doc, from: string, to: string): string | null {
  if (from === to) return null;
  for (const a of readArrows(doc)) {
    if ((a.from === from && a.to === to) || (a.from === to && a.to === from)) return null;
  }
  const id = newId();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("from", from);
    map.set("to", to);
    arrowsOf(doc).set(id, map);
  }, LOCAL);
  return id;
}

export function updateArrow(doc: Y.Doc, id: string, fields: { label?: string | null; color?: string | null }): void {
  const map = arrowsOf(doc).get(id);
  if (!map) return;
  doc.transact(() => {
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === "") map.delete(key);
      else if (value !== undefined) map.set(key, value);
    }
  }, LOCAL);
}

export function removeArrows(doc: Y.Doc, ids: Iterable<string>): void {
  doc.transact(() => {
    for (const id of ids) arrowsOf(doc).delete(id);
  }, LOCAL);
}

/* ------------------------------------------------------------------ history */

/**
 * Makes the board's cards and arrows exactly those of `source` (another copy of it, such as a saved version), in one
 * step: an ordinary edit, so everyone with the board open sees it and it can be undone.
 */
export function replaceBoard(doc: Y.Doc, source: Y.Doc): void {
  const copy = (map: Y.Map<unknown>): Y.Map<unknown> => {
    const out = new Y.Map<unknown>();
    for (const [key, value] of map) {
      out.set(
        key,
        value instanceof Y.Text ? new Y.Text(value.toString()) : value instanceof Y.Map ? copy(value) : value,
      );
    }
    return out;
  };
  doc.transact(() => {
    for (const target of [cardsOf(doc), arrowsOf(doc)]) for (const id of [...target.keys()]) target.delete(id);
    for (const [id, map] of cardsOf(source)) cardsOf(doc).set(id, copy(map));
    for (const [id, map] of arrowsOf(source)) arrowsOf(doc).set(id, copy(map));
  }, LOCAL);
}

/* ------------------------------------------------------------------ columns */

/** Where a card is on the board, column or not. */
export function absolutePosition(card: Card, byId: Map<string, Card>): { x: number; y: number } {
  const parent = card.parent ? byId.get(card.parent) : undefined;
  return parent ? { x: card.x + parent.x, y: card.y + parent.y } : { x: card.x, y: card.y };
}

/**
 * Stacks a column's cards top to bottom in the order they're in now, sized to the column's width, and makes the column
 * tall enough for them. `heights` are the cards' drawn heights (they grow with their content).
 */
export function layoutColumn(doc: Y.Doc, columnId: string, heights: Map<string, number>): void {
  const cards = readCards(doc);
  const column = cards.find((c) => c.id === columnId && c.type === "column");
  if (!column) return;
  const children = cards.filter((c) => c.parent === columnId).sort((a, b) => a.y - b.y || a.x - b.x);
  doc.transact(() => {
    let y = COLUMN_HEADER;
    const w = column.w - 2 * COLUMN_GAP;
    for (const child of children) {
      updateCard(doc, child.id, { x: COLUMN_GAP, y, w });
      y += (heights.get(child.id) ?? child.h) + COLUMN_GAP;
    }
    updateCard(doc, columnId, { h: Math.max(CARD_SIZES.column.h, y + COLUMN_GAP) });
  }, LOCAL);
}

/**
 * Puts a card into a column (at a board position, so it lands where it was dropped) or takes it out (`columnId` null),
 * then stacks the columns it left and joined.
 */
export function setColumn(
  doc: Y.Doc,
  cardId: string,
  columnId: string | null,
  at: { x: number; y: number },
  heights: Map<string, number>,
): void {
  const cards = readCards(doc);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const card = byId.get(cardId);
  if (!card || card.type === "column") return;
  const column = columnId ? byId.get(columnId) : undefined;
  const before = card.parent;
  doc.transact(() => {
    if (column) updateCard(doc, cardId, { parent: column.id, x: at.x - column.x, y: at.y - column.y });
    else updateCard(doc, cardId, { parent: undefined, x: at.x, y: at.y, w: CARD_SIZES[card.type].w });
    if (before && before !== column?.id) layoutColumn(doc, before, heights);
    if (column) layoutColumn(doc, column.id, heights);
  }, LOCAL);
}

/* ------------------------------------------------------------------ the summary the server indexes */

export interface DocRef {
  id: string;
  folder: string;
  title: string;
}

/**
 * The markdown saved with the board: the docs on it as [[links]] (so they show the board in their backlinks), then the
 * notes, columns, links and arrow labels as text (so search finds the board). Read top to bottom, left to right.
 */
export function summaryMarkdown(doc: Y.Doc, docs: Map<string, DocRef>): string {
  const cards = readCards(doc);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const ordered = [...cards].sort((a, b) => {
    const pa = absolutePosition(a, byId);
    const pb = absolutePosition(b, byId);
    return pa.y - pb.y || pa.x - pb.x;
  });

  const links: string[] = [];
  const text: string[] = [];
  for (const card of ordered) {
    switch (card.type) {
      case "doc": {
        const ref = docs.get(card.docId);
        if (ref) links.push(`- [[${ref.folder ? `${ref.folder}/${ref.title}` : ref.title}]]`);
        break;
      }
      case "note": {
        const note = card.text.toString().trim();
        if (note) text.push(note);
        break;
      }
      case "column":
        if (card.title.trim()) text.push(`## ${card.title.trim()}`);
        break;
      case "link":
        text.push(`[${(card.title ?? card.url).replace(/[[\]]/g, "")}](${card.url})`);
        break;
      case "image":
        if (card.alt) text.push(card.alt);
        break;
    }
  }
  for (const arrow of readArrows(doc)) if (arrow.label?.trim()) text.push(arrow.label.trim());

  return [...(links.length ? [links.join("\n")] : []), ...text].join("\n\n");
}
