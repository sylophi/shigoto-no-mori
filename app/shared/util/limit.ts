// Bounded concurrency for work that fans out as wide as the caller
// happens to ask for. Pure (no node builtins, no electron), so it lives
// in shared/ and both the host probes and the web hub connection's
// single-slot lifecycle serializer use the one implementation.
//
// The tidy surface is the reason it started here: it asks about every
// worktree in every project at once, so both its git probes and its
// directory walks would otherwise start as one burst of hundreds of
// processes and syscalls. Queueing them behind a small window makes the
// first results land sooner and leaves the rest of the app some IO.
type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter rather than releasing
      // and re-taking it: a release would let a caller arriving in the
      // same tick jump the queue and push us over the limit.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
