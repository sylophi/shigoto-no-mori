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
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- target strings are short (branch/script names); precomputing a position map per call is more allocation than the linear scan it replaces
    const next = t.indexOf(c, pos);
    if (next < 0) return 0;
    gaps += next - pos;
    pos = next + 1;
  }
  return Math.max(1, 80 - gaps);
}

// Filter + rank items by scoreMatch, best match first. An empty query
// returns the list as-is so callers keep their existing order (matches
// scoreMatch's "empty query = stable sort" contract).
export function rankByScore<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string,
): readonly T[] {
  if (!query) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = scoreMatch(query, text(item));
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.item);
}
