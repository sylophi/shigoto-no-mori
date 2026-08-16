const DAY = 86_400;

// Formats an elapsed span as a coarse duration label ("12s", "3h", "5d",
// "8mo"). Granularity is deliberately low: seconds under a minute, then
// minutes, hours, days, and past a fortnight weeks, months, years. A
// stale worktree reading "8mo" says more at a glance than "247d".
// Callers that want a timestamp read formatRelativeTime. This bare form
// is for spans that aren't "ago" (a worktree's age, a run's duration).
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < DAY) return `${Math.round(sec / 3600)}h`;
  if (sec < 14 * DAY) return `${Math.round(sec / DAY)}d`;
  if (sec < 60 * DAY) return `${Math.round(sec / (7 * DAY))}w`;
  if (sec < 365 * DAY) return `${Math.round(sec / (30 * DAY))}mo`;
  return `${Math.round(sec / (365 * DAY))}y`;
}

// Formats a millisecond timestamp as a coarse relative-time label
// suitable for inline use ("12s ago", "3h ago").
export function formatRelativeTime(
  ts: number,
  now: number = Date.now(),
): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 5) return "just now";
  return `${formatDuration(sec * 1000)} ago`;
}
