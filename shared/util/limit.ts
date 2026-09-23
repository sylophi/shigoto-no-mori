// A FIFO limiter: at most `limit` tasks run at once, and waiters start
// strictly in the order they called. Pure (no node builtins, no
// electron), so it lives in shared/ and the host and the web client
// use the one implementation.
//
// Kept on purpose. The fan-out users it once served (the tidy
// surface's git probes and directory walks, the worktree row probes)
// moved to Effect (`Effect.forEach` with `concurrency`, a Semaphore
// for the directory reads). What is left are single-slot lifecycle
// serializers whose correctness is call order: a `stop` queued behind
// a `start` must run after it, never before. An Effect Semaphore
// cannot stand in for them, because it wakes its waiters in scheduler
// order, not in the order they queued. The users, and the only ones it
// should have: the cloudflared runner (host/direct/cloudflared.ts), the
// socket host (host/socket/server.ts), the ws client transport's
// in-order sends (shared/ipc/socket/wsClientTransport.ts) and the hub
// connection core (shared/hub/connection.ts).
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
