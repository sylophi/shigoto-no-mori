// Tiny in-memory cache with a TTL. Used by the per-project config and
// the global config to avoid a CLI read on every IPC call while
// keeping invalidation cheap (write paths call `invalidate`).
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

interface Entry<V> {
  value: V;
  expires: number;
}

export interface TtlMapCache<K, V> {
  get(key: K): Promise<V>;
  invalidate(key: K): void;
  // Drops every entry at once, for writers that can't name what changed.
  clear(): void;
}

export function ttlMapCache<K, V>(
  ttlMs: number,
  load: (key: K) => Promise<V>,
): TtlMapCache<K, V> {
  const store = new Map<K, Entry<V>>();
  // Coalescing: gets that miss while a load for the same key is running
  // share that load's promise (settled values and rejections alike)
  // instead of each spawning their own. The entry detaches once the
  // load settles, and also on invalidate/clear, so a post-invalidate
  // get starts a fresh load rather than adopting the pre-write one.
  // Rejections are therefore never cached and never wedge the key.
  const inflight = new Map<K, Promise<V>>();
  // Bumped on invalidate so an in-flight load that started before a
  // write can't re-cache the pre-write value for a fresh TTL after the
  // writer invalidated. The stale value still goes to the callers that
  // shared the load (unavoidable), but never back into the cache.
  // clear() bumps a cache-wide epoch instead of per-key generations:
  // in-flight keys may not be in the store yet, and the only cost of an
  // over-broad bump is one skipped re-cache.
  const generations = new Map<K, number>();
  let epoch = 0;
  return {
    get(key) {
      const now = Date.now();
      const hit = store.get(key);
      if (hit && hit.expires > now) return Promise.resolve(hit.value);
      const pending = inflight.get(key);
      if (pending) return pending;
      const generation = generations.get(key) ?? 0;
      const startEpoch = epoch;
      const loading = load(key)
        .then((value) => {
          if (
            (generations.get(key) ?? 0) === generation &&
            epoch === startEpoch
          ) {
            store.set(key, { value, expires: now + ttlMs });
          }
          return value;
        })
        .finally(() => {
          // Identity-guarded: invalidate may have detached this load
          // already and a successor may be in flight.
          if (inflight.get(key) === loading) inflight.delete(key);
        });
      inflight.set(key, loading);
      return loading;
    },
    invalidate(key) {
      store.delete(key);
      inflight.delete(key);
      generations.set(key, (generations.get(key) ?? 0) + 1);
    },
    clear() {
      epoch += 1;
      store.clear();
      inflight.clear();
    },
  };
}

// The same for a load that is an effect: a miss while one load for the
// key runs waits for that load, and a failed load is never kept.
export function ttlEffectCache<K, A, E, R>(
  ttlMs: number,
  load: (key: K) => Effect.Effect<A, E, R>,
): { get: (key: K) => Effect.Effect<A, E, R> } {
  const store = new Map<K, Entry<A>>();
  const inflight = new Map<K, Deferred.Deferred<A, E>>();
  return {
    get: (key) =>
      Effect.suspend(() => {
        const now = Date.now();
        const hit = store.get(key);
        if (hit && hit.expires > now) return Effect.succeed(hit.value);
        const pending = inflight.get(key);
        if (pending) return Deferred.await(pending);
        const loading = Deferred.makeUnsafe<A, E>();
        inflight.set(key, loading);
        return load(key).pipe(
          Effect.tap((value) =>
            Effect.sync(() => store.set(key, { value, expires: now + ttlMs })),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              inflight.delete(key);
              Deferred.doneUnsafe(loading, exit);
            }),
          ),
        );
      }),
  };
}
