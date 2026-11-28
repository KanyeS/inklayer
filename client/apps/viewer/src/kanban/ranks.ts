/**
 * Fractional ranks: strings of 0-9a-z, compared as plain strings, with room for another between any two. They never end in
 * 0, so there's always room before one too. Two people moving cards at once get ranks that merge (ties go by id). The
 * server's copy is Ranks in server/src/Inklayer.Api/Features/Kanban/KanbanDoc.cs.
 */

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A rank after `before` (null: the start) and before `after` (null: the end). */
export function rankBetween(before: string | null | undefined, after: string | null | undefined): string {
  const a = before ?? "";
  let b: string | null = after ?? null;
  if (b !== null && a >= b) b = null; // out of order (two people moved at once): just go after
  let result = "";
  for (let i = 0; ; i++) {
    const low = Math.max(i < a.length ? DIGITS.indexOf(a.charAt(i)) : 0, 0);
    let high = b !== null && i < b.length ? DIGITS.indexOf(b.charAt(i)) : DIGITS.length;
    if (high < 0) high = DIGITS.length;
    if (low === high) {
      result += DIGITS[low];
      continue;
    }
    const mid = Math.floor((low + high) / 2);
    if (mid > low) return result + DIGITS[mid];
    // Next to each other: keep the lower digit; anything after it is below the upper bound.
    result += DIGITS[low];
    b = null;
  }
}

/** Compares two ranked things: by rank, then id, so everyone sorts ties the same way. */
export function byRank(a: { rank: string; id: string }, b: { rank: string; id: string }): number {
  return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
