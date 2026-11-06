/** Subsequence match score: +1 per matched char, +3 if contiguous, +2 at word start. null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().trim();
  const s = text.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] !== q[qi]) continue;
    score += 1; // +1 per matched char
    if (i === prev + 1) score += 3; // +3 if contiguous
    if (i === 0 || s[i - 1] === " ") score += 2; // +2 at word start
    prev = i;
    qi++;
  }
  return qi === q.length ? score : null;
}

export function rank<T>(items: T[], query: string, text: (x: T) => string): T[] {
  if (!query.trim()) return items;
  return items
    .map((x, i) => ({ x, i, s: fuzzyScore(query, text(x)) }))
    .filter((r): r is { x: T; i: number; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((r) => r.x);
}
