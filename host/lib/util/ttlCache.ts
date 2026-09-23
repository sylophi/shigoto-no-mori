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
import { Cache, Duration, Effect, Exit } from "effect";

export interface TtlMapCache<K, V> {
  get(key: K): Promise<V>;
  invalidate(key: K): void;
  // Drops every entry at once, for writers that can't name what changed.
  clear(): void;
}

// Keys are few (projects, worktrees, repos), never a hostile stream,
// so the capacity is a safety bound rather than a budget.
const CAPACITY = 10_000;

function makeCache<K, V>(
  ttlMs: number,
  load: (key: K) => Promise<V>,
): Cache.Cache<K, V, unknown> {
  return Effect.runSync(
    Cache.makeWith<K, V, unknown, never>(
      (key) => Effect.tryPromise({ try: () => load(key), catch: (e) => e }),
      {
        capacity: CAPACITY,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? Duration.millis(ttlMs) : Duration.zero,
      },
    ),
  );
}

export function ttlMapCache<K, V>(
  ttlMs: number,
  load: (key: K) => Promise<V>,
): TtlMapCache<K, V> {
  const cache = makeCache(ttlMs, load);
  return {
    get: (key) => Effect.runPromise(Cache.get(cache, key)),
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
  // invalidate() overtook; `last` must not adopt it either, so a load
  // records its value only if no invalidate() ran since it started.
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
    expire: () => Effect.runSync(Cache.invalidateAll(cache)),
  };
}
