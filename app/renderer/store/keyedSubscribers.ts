// A Map of key -> Set of callbacks, written once. The part worth not
// repeating is the unsubscribe: drop the callback, then prune the empty
// bucket so short-lived keys don't leak empty Sets. P is what notify
// hands each callback. The default is nothing, a plain "changed" ping.
export class KeyedSubscribers<K, P = void> {
  private buckets = new Map<K, Set<(payload: P) => void>>();

  subscribe(key: K, cb: (payload: P) => void): () => void {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new Set();
      this.buckets.set(key, bucket);
    }
    bucket.add(cb);
    return () => {
      const current = this.buckets.get(key);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.buckets.delete(key);
    };
  }

  notify(key: K, payload: P): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    for (const cb of bucket) cb(payload);
  }
}
