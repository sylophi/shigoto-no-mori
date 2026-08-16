// Formats an elapsed span as a coarse duration label ("12s", "3h",
// "5d"). Granularity is deliberately low: seconds under a minute, then
// minutes, hours, days. Callers that want a timestamp read
// formatRelativeTime. This bare form is for spans that aren't "ago"
// (a worktree's age, a run's duration).
export function formatDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
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
