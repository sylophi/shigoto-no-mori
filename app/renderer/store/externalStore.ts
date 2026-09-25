// One value, many useSyncExternalStore readers: the unkeyed sibling of
// KeyedSubscribers. `publish` swaps the snapshot (a new reference per
// change, which is the contract) and wakes every subscriber.
import { useSyncExternalStore } from "react";

export type ExternalStore<T> = {
  get: () => T;
  subscribe: (listener: () => void) => () => void;
  publish: (next: T) => void;
};

export function createExternalStore<T>(initial: T): ExternalStore<T> {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
}

// The React binding: the whole snapshot as the value. The server
// snapshot is the same getter, since nothing here renders on a server.
// A reader that wants one field of a snapshot writes its own selector
// over useSyncExternalStore instead, so a change elsewhere in the
// snapshot leaves it alone.
export function useExternalStore<T>(store: ExternalStore<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
