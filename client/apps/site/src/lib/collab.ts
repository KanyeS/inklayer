/**
 * Live editing without a server. The visitor's editor works on a Room's Y.Doc; each pretend teammate has a Y.Doc and
 * awareness of their own, kept in step with the room's by passing Yjs updates in memory, much as the server's docs hub
 * relays them between browsers. So the teammates' edits merge with the visitor's like any other collaborator's, and their
 * carets are drawn by the editor's real collaboration plugin (y-codemirror). Nothing is saved.
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Person } from "./people";
import type { Ctx } from "./scene";

interface AwarenessChanges {
  added: number[];
  updated: number[];
  removed: number[];
}

/** Where someone's pointer is, as the viewer shares it: a position in the text plus an offset from it, in pixels. */
export interface TextPointer {
  pos: number;
  dx: number;
  dy: number;
}

/** Each person's awareness `user`, as the viewer sets it (AwarenessUser): y-codemirror draws carets with it. */
const userFor = (person: Person) => ({
  name: person.name,
  color: person.color,
  colorLight: `${person.color}33`,
  peerId: person.id,
});

/** One end of the in-memory link: a doc and its awareness. */
interface Replica {
  doc: Y.Doc;
  awareness: Awareness;
}

/** Marks changes passed between replicas here, so they aren't passed on again. */
const RELAY = Symbol("relay");

/** Edits are sent in batches this often, as the viewer's DocSession does (FLUSH_MS), so others see them arrive the same way. */
const FLUSH_MS = 250;

export class Room implements Replica {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("content");
  readonly awareness = new Awareness(this.doc);
  readonly canEdit = true;
  readonly #members: Replica[] = [];

  constructor(visitor: Person) {
    this.awareness.setLocalStateField("user", userFor(visitor));
    this.#register(this);
  }

  /** Adds a teammate with their own copy of the doc: they get the text and everyone's carets, and everyone gets theirs. */
  join(person: Person): Teammate {
    const teammate = new Teammate(person);
    Y.applyUpdate(teammate.doc, Y.encodeStateAsUpdate(this.doc), RELAY);
    for (const member of this.#members) {
      applyAwarenessUpdate(teammate.awareness, encodeAwarenessUpdate(member.awareness, [member.doc.clientID]), RELAY);
      applyAwarenessUpdate(member.awareness, encodeAwarenessUpdate(teammate.awareness, [teammate.doc.clientID]), RELAY);
    }
    this.#register(teammate);
    return teammate;
  }

  /** Replaces the whole text (for "Start over"); everyone's copy follows. */
  setText(content: string): void {
    this.doc.transact(() => {
      this.text.delete(0, this.text.length);
      this.text.insert(0, content);
    });
  }

  /** From now on, the member's own edits (batched) and caret moves (straight away) reach everyone else. */
  #register(member: Replica): void {
    let pending: Uint8Array[] = [];
    let timer = 0;
    const flush = () => {
      timer = 0;
      const update = Y.mergeUpdates(pending);
      pending = [];
      for (const to of this.#members) if (to !== member) Y.applyUpdate(to.doc, update, RELAY);
    };
    member.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === RELAY) return;
      pending.push(update);
      if (!timer) timer = window.setTimeout(flush, FLUSH_MS);
    });
    member.awareness.on("update", ({ added, updated, removed }: AwarenessChanges, origin: unknown) => {
      if (origin === RELAY) return;
      const update = encodeAwarenessUpdate(member.awareness, [...added, ...updated, ...removed]);
      for (const to of this.#members) if (to !== member) applyAwarenessUpdate(to.awareness, update, RELAY);
    });
    this.#members.push(member);
  }
}

/** A pretend collaborator, editing their own copy of the doc. */
export class Teammate implements Replica {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("content");
  readonly awareness = new Awareness(this.doc);
  /** Where the caret is, as a position that moves with other people's edits. */
  #caret: Y.RelativePosition | null = null;

  constructor(readonly person: Person) {
    this.awareness.setLocalStateField("user", userFor(person));
  }

  /** The caret's index in the text now. */
  get caret(): number {
    if (!this.#caret) return this.text.length;
    return Y.createAbsolutePositionFromRelativePosition(this.#caret, this.doc)?.index ?? this.text.length;
  }

  /** Puts the caret at an index, or selects from `index` to `head`. Others see it, with the person's name. */
  placeCaret(index: number, head = index): void {
    // Anchored to the character before (assoc -1), so a caret at the very end still points at a character: a position
    // with nothing to point at crashes y-codemirror's remote-caret drawing.
    const relative = (i: number) => Y.createRelativePositionFromTypeIndex(this.text, i, i > 0 ? -1 : 0);
    const at = (i: number) => Y.relativePositionToJSON(relative(i));
    this.#caret = relative(head);
    this.awareness.setLocalStateField("cursor", { anchor: at(index), head: at(head) });
  }

  /** Shares where their mouse is: at a position in the text (null when it's off the doc, or they're only typing). */
  pointAt(pos: number | null): void {
    this.awareness.setLocalStateField("pointer", pos === null ? null : ({ pos, dx: 2, dy: 12 } satisfies TextPointer));
  }

  /** The caret just after the first occurrence of `phrase` (or at the end). */
  placeAfter(phrase: string): void {
    const at = this.text.toString().indexOf(phrase);
    this.placeCaret(at < 0 ? this.text.length : at + phrase.length);
  }

  /** Selects `phrase` by dragging across it with the mouse, which others see too. */
  async select(ctx: Ctx, phrase: string, ms = 700): Promise<void> {
    const start = this.text.toString().indexOf(phrase);
    if (start < 0) return;
    this.placeCaret(start);
    await ctx.animate(
      ms,
      (t) => {
        const head = start + Math.round(phrase.length * t);
        this.placeCaret(start, head);
        this.pointAt(head);
      },
      true,
    );
    await ctx.sleep(600);
    this.pointAt(null);
  }

  /** Types at the caret, a character at a time. */
  async type(ctx: Ctx, text: string, charsPerSecond = 22): Promise<void> {
    let typed = 0;
    await ctx.type(
      text,
      (soFar) => {
        const index = this.caret;
        this.text.insert(index, soFar.slice(typed));
        typed = soFar.length;
        this.placeCaret(index + 1);
      },
      charsPerSecond,
    );
  }

  /** Inserts a piece in one go (a mention, which someone would pick from the suggestions rather than type). */
  insert(text: string): void {
    const index = this.caret;
    this.text.insert(index, text);
    this.placeCaret(index + text.length);
  }

  /** Lets go: no caret, no pointer. */
  leave(): void {
    this.awareness.setLocalStateField("cursor", null);
    this.awareness.setLocalStateField("pointer", null);
  }
}
