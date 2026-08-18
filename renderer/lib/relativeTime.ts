// Formats a millisecond timestamp as a coarse relative-time label
// suitable for inline use ("12s ago", "3h ago"). Granularity is
// deliberately low: seconds under a minute, then minutes, hours, days,
// and past a fortnight weeks/months/years -- a stale worktree reading
// "8mo ago" says more at a glance than "247d ago".
const DAY = 86_400;

export function formatRelativeTime(
  ts: number,
  now: number = Date.now(),
): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < DAY) return `${Math.round(sec / 3600)}h ago`;
  if (sec < 14 * DAY) return `${Math.round(sec / DAY)}d ago`;
  if (sec < 60 * DAY) return `${Math.round(sec / (7 * DAY))}w ago`;
  if (sec < 365 * DAY) return `${Math.round(sec / (30 * DAY))}mo ago`;
  return `${Math.round(sec / (365 * DAY))}y ago`;
}
