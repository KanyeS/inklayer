import type * as Y from "yjs";
import { LOCAL } from "./boardModel";

/** Changes a shared text to `next` with the smallest edit (one deletion and one insertion), so others' typing merges. */
export function setText(text: Y.Text, next: string): void {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }
  const apply = () => {
    if (endPrev > start) text.delete(start, endPrev - start);
    if (endNext > start) text.insert(start, next.slice(start, endNext));
  };
  if (text.doc) text.doc.transact(apply, LOCAL);
  else apply();
}

type Delta = { insert?: unknown; retain?: number; delete?: number }[];

/** Where a caret at `pos` ends up after someone else's change (as a Yjs text delta). */
export function shiftPosition(pos: number, delta: Delta): number {
  let index = 0;
  let at = pos;
  for (const op of delta) {
    if (op.retain) index += op.retain;
    else if (op.insert !== undefined) {
      const length = typeof op.insert === "string" ? op.insert.length : 1;
      if (index <= at) at += length;
      index += length;
    } else if (op.delete) {
      if (index < at) at -= Math.min(op.delete, at - index);
    }
  }
  return at;
}
