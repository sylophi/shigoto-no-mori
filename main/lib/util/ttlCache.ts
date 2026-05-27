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
  // Drops every entry whose key starts with the given prefix. Only meaningful
  // for string-keyed caches; throws on other key shapes so misuse stays loud.
  invalidateByPrefix(prefix: K extends string ? string : never): void;
}

export function ttlMapCache<K, V>(
  ttlMs: number,
  load: (key: K) => Promise<V>,
): TtlMapCache<K, V> {
  const store = new Map<K, Entry<V>>();
  return {
    async get(key) {
      const now = Date.now();
      const hit = store.get(key);
      if (hit && hit.expires > now) return hit.value;
      const value = await load(key);
      store.set(key, { value, expires: now + ttlMs });
      return value;
    },
    invalidate(key) {
      store.delete(key);
    },
    invalidateByPrefix(prefix) {
      for (const key of store.keys()) {
        if (typeof key !== "string") {
          throw new Error(
            "invalidateByPrefix only works on string-keyed caches",
          );
        }
        if (key.startsWith(prefix)) store.delete(key);
      }
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
  return {
    async get() {
      const now = Date.now();
      if (entry && entry.expires > now) return entry.value;
      const value = await load();
      entry = { value, expires: now + ttlMs };
      return value;
    },
    invalidate() {
      entry = null;
    },
  };
}
