// Shared rolling-window usage log. The launcher row and the package.json
// scripts list both rank entries by "how often did the user run this in
// the last 14 days" — same algorithm, different storage shape, so the
// math lives here while the callers own their store layout.

export const USE_LOG_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function countWithin(
  timestamps: readonly number[],
  now: number,
  windowMs: number = USE_LOG_WINDOW_MS,
): number {
  const cutoff = now - windowMs;
  let n = 0;
  for (const t of timestamps) if (t >= cutoff) n++;
  return n;
}

export function maxTimestamp(timestamps: readonly number[]): number {
  let max = 0;
  for (const t of timestamps) if (t > max) max = t;
  return max;
}

export function pruneAndPush(
  timestamps: readonly number[],
  now: number,
  windowMs: number = USE_LOG_WINDOW_MS,
): number[] {
  const cutoff = now - windowMs;
  const fresh = timestamps.filter((t) => t >= cutoff);
  fresh.push(now);
  return fresh;
}
