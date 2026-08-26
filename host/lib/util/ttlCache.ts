// Tiny in-memory cache with a TTL. Used by the per-project config and
// the global config to avoid re-reading disk on every IPC call while
// keeping invalidation cheap (write paths call `invalidate`).

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

export interface TtlValueCache<V> {
  get(): Promise<V>;
  invalidate(): void;
}

export function ttlValueCache<V>(
  ttlMs: number,
  load: () => Promise<V>,
): TtlValueCache<V> {
  let entry: Entry<V> | null = null;
  // Same in-flight-load-vs-invalidate guard as ttlMapCache above.
  let generation = 0;
  return {
    async get() {
      const now = Date.now();
      if (entry && entry.expires > now) return entry.value;
      const startGeneration = generation;
      const value = await load();
      if (generation === startGeneration) {
        entry = { value, expires: now + ttlMs };
      }
      return value;
    },
    invalidate() {
      entry = null;
      generation += 1;
    },
  };
}
