// Shared rolling-window usage log. The launcher row and the package.json
// scripts list both rank entries by "how often did the user run this in
// the last 14 days". Same algorithm, different storage shape, so the
// math lives here while the callers own their store layout.

export const USE_LOG_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function countWithin(
  timestamps: readonly number[],
  now: number,
): number {
  const cutoff = now - USE_LOG_WINDOW_MS;
  let n = 0;
  for (const t of timestamps) if (t >= cutoff) n++;
  return n;
}

export function maxTimestamp(timestamps: readonly number[]): number {
  let max = 0;
  for (const t of timestamps) if (t > max) max = t;
  return max;
}

// Per name in `names`: its latest use and its count within the window,
// read from a log keyed by name. A name the log lacks reads as unused.
export function usageByName(
  names: readonly string[],
  log: Readonly<Record<string, readonly number[]>>,
): Record<string, { lastUsed: number; recentCount: number }> {
  const now = Date.now();
  const out: Record<string, { lastUsed: number; recentCount: number }> = {};
  for (const name of names) {
    const timestamps = log[name] ?? [];
    out[name] = {
      lastUsed: maxTimestamp(timestamps),
      recentCount: countWithin(timestamps, now),
    };
  }
  return out;
}

export function pruneAndPush(
  timestamps: readonly number[],
  now: number,
): number[] {
  const cutoff = now - USE_LOG_WINDOW_MS;
  const fresh = timestamps.filter((t) => t >= cutoff);
  fresh.push(now);
  return fresh;
}
