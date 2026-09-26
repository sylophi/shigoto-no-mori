// One in-flight run at a time: a caller arriving while a run is under
// way rides that run's promise instead of starting a second one, and
// the slot clears once the run settles, so the next caller after that
// starts afresh. For the operations that must not race themselves (an
// enroll rotates the credential, a revoke deletes the credential the
// second revoke would 401 against).
export function singleFlight<T>(): (run: () => Promise<T>) => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return async (run) => {
    if (inFlight) return inFlight;
    inFlight = run();
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}
