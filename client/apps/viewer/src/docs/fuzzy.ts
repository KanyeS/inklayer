/** Characters of the query in order within the title; consecutive and word-start matches score higher. Null: no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  if (t.includes(q)) return 500 - t.indexOf(q);
  let score = 0;
  let last = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = t.indexOf(ch, last + 1);
    if (at < 0) return null;
    score += at === last + 1 ? 5 : 0;
    score += at === 0 || /[\s/_-]/.test(t[at - 1]!) ? 3 : 0;
    score -= at - last;
    last = at;
  }
  return score;
}
