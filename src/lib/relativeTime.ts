// Formats a millisecond timestamp as a coarse relative-time label
// suitable for inline use ("12s ago", "3h ago"). Granularity is
// deliberately low: seconds under a minute, then minutes, hours, days.
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
}
