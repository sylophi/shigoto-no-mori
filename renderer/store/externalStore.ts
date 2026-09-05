// One value, many useSyncExternalStore readers: the unkeyed sibling of
// KeyedSubscribers. `publish` swaps the snapshot (a new reference per
// change, which is the contract) and wakes every subscriber.
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
