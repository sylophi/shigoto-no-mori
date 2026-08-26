// The lifecycle bookkeeping shared by the host's ephemeral resource
// registries (sync bundle transfers, forward conns): a plain in-memory
// Map of minted ids in this (host/main) process, a last-touched stamp
// per entry, and ONE idle sweep as the entire cleanup story. A caller
// that vanished mid-use leaks at most one entry for the registry's
// idle window. Nothing survives a restart and nothing is persisted --
// a hard crash of this process skips the sweep entirely, so anything
// an entry owns on disk orphans until the OS reclaims it. Both
// consumers are grant-gated already (a trusted peer), so there are
// deliberately no per-peer quotas here.
import { randomBytes } from "node:crypto";

// The host-minted opaque id whose wire shape HexId32Schema
// (shared/ipc/hexId.ts) pins: 16 random bytes, hex. Lives here rather
// than beside the schema because shared/ modules must stay free of
// node builtins.
export function mintHexId(): string {
  return randomBytes(16).toString("hex");
}

const SWEEP_INTERVAL_MS = 60_000;

export type IdleRegistry<T> = {
  // Mints a fresh id for `value` and arms the sweep.
  mint: (value: T) => string;
  get: (id: string) => T | undefined;
  // Stamps a live entry's last-touched time. Unknown ids are a no-op.
  touch: (id: string) => void;
  // Forgets the entry FIRST, unconditionally (the Map must shrink even
  // if the drop callback loses a race), then runs onDrop synchronously
  // before the returned promise's first await, so teardown effects a
  // caller relies on in the same tick still happen. Idempotent:
  // dropping an unknown id resolves as a no-op.
  drop: (id: string) => Promise<void>;
  // Live entry count, for callers with a sanity cap.
  size: () => number;
};

export function createIdleRegistry<T>({
  idleMs,
  onDrop,
}: {
  idleMs: number;
  // Best-effort teardown for a dropped entry. Runs from the sweep
  // timer too (void'd), where a rejection would be an unhandled
  // rejection that takes down the main process -- so swallow expected
  // failures inside the callback.
  onDrop: (value: T) => void | Promise<void>;
}): IdleRegistry<T> {
  type Entry = { value: T; touched: number };
  const entries = new Map<string, Entry>();
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  function ensureSweep(): void {
    if (sweepTimer !== null) return;
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of entries) {
        if (now - entry.touched > idleMs) void drop(id);
      }
      if (entries.size === 0 && sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
    }, SWEEP_INTERVAL_MS);
    // Never hold the process open for housekeeping.
    sweepTimer.unref?.();
  }

  function mint(value: T): string {
    const id = mintHexId();
    entries.set(id, { value, touched: Date.now() });
    ensureSweep();
    return id;
  }

  function get(id: string): T | undefined {
    return entries.get(id)?.value;
  }

  function touch(id: string): void {
    const entry = entries.get(id);
    if (entry !== undefined) entry.touched = Date.now();
  }

  function drop(id: string): Promise<void> {
    const entry = entries.get(id);
    if (entry === undefined) return Promise.resolve();
    entries.delete(id);
    return Promise.resolve(onDrop(entry.value));
  }

  return { mint, get, touch, drop, size: () => entries.size };
}
