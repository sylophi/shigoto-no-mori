// Tiny in-memory cache with a TTL. Used by the per-project config and
// the global config to avoid re-reading disk on every IPC call while
// keeping invalidation cheap (write paths call `invalidate`).
//
// Effect's Cache underneath, which owns the rules this file used to
// keep by hand: gets that miss while a load for the same key is running
// share that load (settled values and rejections alike) instead of each
// spawning their own; a rejection is never cached and never wedges the
// key (its time to live is zero); and an invalidate during a load
// discards that load's result once it lands, so a load that started
// before a write can never re-cache the pre-write value for a fresh
// TTL after the writer invalidated. The stale value still goes to the
// callers that shared the load (unavoidable), but never back into the
// cache. The Promise surface stays for the callers that are not
// Effects yet.
import { Cache, Cause, Duration, Effect, Exit } from "effect";

export interface TtlMapCache<K, V> {
  get(key: K): Promise<V>;
  invalidate(key: K): void;
  // Drops every entry at once, for writers that can't name what changed.
  clear(): void;
}

// Keys are few (projects, worktrees, repos), never a hostile stream,
// so the capacity is a safety bound rather than a budget.
const CAPACITY = 10_000;

// The same Cache for a lookup that is an Effect: a success is kept for
// `ttl`, a failure never (its time to live is zero), so the next ask
// retries.
export function makeTtlCache<K, A, E>(
  lookup: (key: K) => Effect.Effect<A, E>,
  ttl: Duration.Duration,
): Cache.Cache<K, A, E> {
  return Effect.runSync(
    Cache.makeWith(lookup, {
      capacity: CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? ttl : Duration.zero),
    }),
  );
}

// Cache.get with an exit the cache will not serve again dropped from
// the map at once. An entry whose time to live is zero is expired the
// moment it lands, but Cache keeps expired entries until its capacity
// sweep, so a failure per key (or every settled single flight) would
// otherwise sit in memory for nothing. An interrupted get drops
// nothing: the lookup may still be serving the callers that stayed.
function dropped<K, A, E>(
  cache: Cache.Cache<K, A, E>,
  key: K,
  exit: Exit.Exit<A, E>,
): Effect.Effect<void> {
  return Exit.isSuccess(exit) || !Cause.hasInterrupts(exit.cause)
    ? Cache.invalidate(cache, key)
    : Effect.void;
}

// A get on a TTL cache: a success is served for its TTL, a failure is
// dropped as soon as it has been handed out.
export function getCached<K, A, E>(
  cache: Cache.Cache<K, A, E>,
  key: K,
): Effect.Effect<A, E> {
  return Cache.get(cache, key).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit) ? Effect.void : dropped(cache, key, exit),
    ),
  );
}

// A single flight per key: concurrent gets share one lookup, and
// nothing outlives it (success or failure alike). Once every caller
// waiting on a lookup has gone the lookup is interrupted.
export function singleFlight<K, A, E>(
  lookup: (key: K) => Effect.Effect<A, E>,
): (key: K) => Effect.Effect<A, E> {
  const cache = makeTtlCache(lookup, Duration.zero);
  return (key) =>
    Cache.get(cache, key).pipe(
      Effect.onExit((exit) => dropped(cache, key, exit)),
    );
}

function makeCache<K, V>(
  ttlMs: number,
  load: (key: K) => Promise<V>,
): Cache.Cache<K, V, unknown> {
  return makeTtlCache(
    (key: K) => Effect.tryPromise({ try: () => load(key), catch: (e) => e }),
    Duration.millis(ttlMs),
  );
}

export function ttlMapCache<K, V>(
  ttlMs: number,
  load: (key: K) => Promise<V>,
): TtlMapCache<K, V> {
  const cache = makeCache(ttlMs, load);
  return {
    get: (key) => Effect.runPromise(getCached(cache, key)),
    invalidate: (key) => Effect.runSync(Cache.invalidate(cache, key)),
    clear: () => Effect.runSync(Cache.invalidateAll(cache)),
  };
}

export interface TtlValueCache<V> {
  get(): Promise<V>;
  // The last stored value, even past its TTL, for sync readers that
  // prefer stale over absent. null before the first load resolves and
  // after invalidate(), while expire() keeps it.
  peek(): V | null;
  // Erase everything: the next get() reloads and peek() answers null
  // until it lands. For writers whose change makes the old value wrong
  // to show at all (nuke wiping the config).
  invalidate(): void;
  // Mark stale without forgetting: the next get() reloads, but peek()
  // keeps serving the last value meanwhile. For writers whose change
  // merely outdates the value, where sync readers must not see a gap.
  expire(): void;
}

export function ttlValueCache<V>(
  ttlMs: number,
  load: () => Promise<V>,
): TtlValueCache<V> {
  // The one value, under the one key. `last` is what peek() serves: the
  // latest value a load produced, kept past the TTL and past expire(),
  // dropped by invalidate(). The Cache already discards a load that
  // invalidate() or expire() overtook; `last` must not adopt it either
  // (a pre-write load landing after the post-write one would put the
  // old value back into peek()), so a load records its value only if
  // neither ran since it started.
  let last: V | null = null;
  let generation = 0;
  const cache = makeCache<null, V>(ttlMs, () => {
    const started = generation;
    return load().then((value) => {
      if (generation === started) last = value;
      return value;
    });
  });
  return {
    get: () => Effect.runPromise(Cache.get(cache, null)),
    peek: () => last,
    invalidate: () => {
      last = null;
      generation += 1;
      Effect.runSync(Cache.invalidateAll(cache));
    },
    expire: () => {
      generation += 1;
      Effect.runSync(Cache.invalidateAll(cache));
    },
  };
}
