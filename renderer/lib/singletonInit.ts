// Wraps a no-arg side effect (typically `window.api.x.onY(handler)`)
// so it runs exactly once across the renderer's lifetime. Use for
// module-level IPC subscribers that don't need cleanup semantics; for
// hook-scoped subscriptions, prefer useEffect with the returned
// unsubscribe.
export function singletonInit(fn: () => void): () => void {
  let started = false;
  return () => {
    if (started) return;
    started = true;
    fn();
  };
}
