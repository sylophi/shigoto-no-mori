// Higher score = better match. 0 = no match. Used to rank substring +
// subsequence matches for fuzzy pickers (branch combobox, package-script
// filter, etc.). Empty query returns 1 so unfiltered lists sort stably.
export function scoreMatch(query: string, target: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 1000;
  const idx = t.indexOf(q);
  if (idx >= 0) {
    return 200 - idx * 2 + Math.round((q.length / t.length) * 50);
  }
  let pos = 0;
  let gaps = 0;
  for (const c of q) {
    const next = t.indexOf(c, pos);
    if (next < 0) return 0;
    gaps += next - pos;
    pos = next + 1;
  }
  return Math.max(1, 80 - gaps);
}
