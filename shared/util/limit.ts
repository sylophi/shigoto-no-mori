// A FIFO limiter: at most `limit` tasks run at once, and waiters start
// strictly in the order they called. Pure (no node builtins, no
// electron), so it lives in shared/ and the host and the web client
// use the one implementation.
//
// For serializers whose correctness is call order: a `stop` queued
// behind a `start` must run after it, never before. An Effect
// Semaphore cannot stand in for one, because it wakes its waiters in
// scheduler order, not in the order they queued. A fan-out wants
// `Effect.forEach` with `concurrency` instead.
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
