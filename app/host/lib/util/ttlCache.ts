// Tiny in-memory cache with a TTL, for a read too slow to repeat on
// every call.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

interface Entry<V> {
  value: V;
  expires: number;
}

// A miss while one load for the key runs waits for that load, and a
// failed load is never kept.
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
