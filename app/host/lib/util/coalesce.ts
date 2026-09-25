// A leading-edge coalescer for change signals that fan out to the
// renderer: the first call schedules `fn` after `ms`, calls in the
// meantime fold into it. unref'd so a pending signal never holds the
// process open on quit.
export function coalesce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
    timer.unref?.();
  };
}
