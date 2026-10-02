// Higher score = better match. 0 = no match. Used to rank substring +
// subsequence matches for fuzzy pickers (branch combobox, package-script
// filter, etc.). Empty query returns 1 so unfiltered lists sort stably.
// A space in the query only separates words as a subsequence, so
// "fix st" finds fix-stale-locks.
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
    if (c === " ") continue;
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- target strings are short (branch/script names); precomputing a position map per call is more allocation than the linear scan it replaces
    const next = t.indexOf(c, pos);
    if (next < 0) return 0;
    gaps += next - pos;
    pos = next + 1;
  }
  return Math.max(1, 80 - gaps);
}

// The letters of `target` scoreMatch matched, for drawing why a row
// matched: the substring's run, else the subsequence's first fit.
// Null when it doesn't match. A query the whole target doesn't take
// (a "project branch" query drawn over the branch alone) falls back to
// its words, each shown where it appears as written.
export function matchPositions(query: string, target: string): number[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return Array.from({ length: q.length }, (_, i) => idx + i);
  const positions: number[] = [];
  let pos = 0;
  const letters = q.replaceAll(" ", "");
  for (const c of letters) {
    const next = t.indexOf(c, pos);
    if (next < 0) break;
    positions.push(next);
    pos = next + 1;
  }
  if (positions.length === letters.length) return positions;
  const words = new Set<number>();
  for (const word of q.split(/\s+/)) {
    const at = t.indexOf(word);
    if (at < 0) continue;
    for (let i = 0; i < word.length; i++) words.add(at + i);
  }
  return words.size > 0 ? [...words].toSorted((a, b) => a - b) : null;
}

// scoreMatch over several fields: the best one's.
export function scoreFields(
  query: string,
  fields: string | readonly string[],
): number {
  if (typeof fields === "string") return scoreMatch(query, fields);
  return Math.max(0, ...fields.map((field) => scoreMatch(query, field)));
}

// Filter + rank items by scoreMatch, best match first. An empty query
// returns the list as-is so callers keep their existing order (matches
// scoreMatch's "empty query = stable sort" contract). An item offering
// several fields scores by its best one, and ties keep the list's order.
// `weight` scales an item's score, to let some sink below matches as
// good as theirs.
export function rankByScore<T>(
  query: string,
  items: readonly T[],
  text: (item: T) => string | readonly string[],
  weight?: (item: T) => number,
): readonly T[] {
  if (!query) return items;
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = scoreFields(query, text(item)) * (weight?.(item) ?? 1);
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.item);
}
