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
  // Bumped on invalidate so an in-flight load that started before a
  // write can't re-cache the pre-write value for a fresh TTL after the
  // writer invalidated. The stale value still goes to the caller that
  // started the load (unavoidable), but never back into the cache.
  // clear() bumps a cache-wide epoch instead of per-key generations:
  // in-flight keys may not be in the store yet, and the only cost of an
  // over-broad bump is one skipped re-cache.
  const generations = new Map<K, number>();
  let epoch = 0;
  return {
    async get(key) {
      const now = Date.now();
      const hit = store.get(key);
      if (hit && hit.expires > now) return hit.value;
      const generation = generations.get(key) ?? 0;
      const startEpoch = epoch;
      const value = await load(key);
      if ((generations.get(key) ?? 0) === generation && epoch === startEpoch) {
        store.set(key, { value, expires: now + ttlMs });
      }
      return value;
    },
    invalidate(key) {
      store.delete(key);
      generations.set(key, (generations.get(key) ?? 0) + 1);
    },
    clear() {
      epoch += 1;
      store.clear();
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
