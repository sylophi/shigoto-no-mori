// A push-subscriber registry: a keyed set of handlers with add, an
// unsubscribe that deletes an empty set, and a fan-out that isolates a
// throwing handler so one bad subscriber cannot stop delivery to the
// rest. Written once here because four transports need the identical
// bookkeeping (the LAN client transport, the hub link's per-peer
// subscribers, the renderer's hub transport, and the web bridge's
// loopback), and one copy had drifted without the try/catch that keeps
// a throwing subscriber from halting the loop.
//
// Pure on purpose: it knows nothing about sockets or the wire. The
// caller keys by whatever it likes, a bare channel on the LAN and hub
// link paths or a composite deviceId plus channel on the renderer path.
import { errorMessageOf } from "@shared/errors";

export type SubscriberRegistry = {
  // Register a handler under a key. The returned function removes it and
  // drops the key's set once it is empty.
  subscribe(key: string, handler: (payload: unknown) => void): () => void;
  // Fan a payload out to every handler under a key. A throwing handler
  // is caught and counted so it cannot stop the rest.
  emit(key: string, payload: unknown): void;
  // Number of live keys, so a caller can release an underlying resource
  // once nothing is subscribed.
  size(): number;
};

export function createSubscriberRegistry(label: string): SubscriberRegistry {
  const sets = new Map<string, Set<(payload: unknown) => void>>();
  let threw = 0;

  return {
    subscribe(key, handler) {
      let handlers = sets.get(key);
      if (handlers === undefined) {
        handlers = new Set();
        sets.set(key, handlers);
      }
      handlers.add(handler);
      return () => {
        const current = sets.get(key);
        if (current === undefined) return;
        current.delete(handler);
        if (current.size === 0) sets.delete(key);
      };
    },
    emit(key, payload) {
      const handlers = sets.get(key);
      if (handlers === undefined) return;
      // A handler may unsubscribe itself here, which Set iteration
      // tolerates. A throwing handler is isolated and its warning is
      // throttled so a noisy subscriber cannot flood the log.
      for (const handler of handlers) {
        try {
          handler(payload);
        } catch (error) {
          threw += 1;
          if (threw % 50 === 1) {
            console.warn(
              `[${label}] push handler threw: ${errorMessageOf(error)} (threw ${threw} so far)`,
            );
          }
        }
      }
    },
    size() {
      return sets.size;
    },
  };
}
