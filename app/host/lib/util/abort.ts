// A callback on a signal's abort, returned as its own remover: the
// signal may outlive the call by a lot (a connection's, a page's), so
// every listener a step attaches comes off when the step is done. A
// signal already aborted runs the callback at once, the way an abort
// arriving a moment later would.
export function onAbort(
  signal: AbortSignal | undefined,
  fn: () => void,
): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}
