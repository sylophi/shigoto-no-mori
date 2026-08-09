// Advisory cross-process file lock for read-modify-write cycles on
// shared JSON state. The app and the CLI can both mutate
// state.json; without a lock, whichever process writes last silently
// drops the other's change. Lock acquisition is sync because the only
// caller (config/store.ts) is sync end to end.
//
// Mechanics: O_EXCL-create a sibling `<file>.lock` holding our pid.
// Contenders spin with a short sleep; a lock older than STALE_MS is
// treated as leaked (holder crashed between create and unlink) and
// broken. Real hold times are milliseconds -- one JSON read + write --
// so the stale threshold is generous.
import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const STALE_MS = 10_000;
const TIMEOUT_MS = 5_000;
const RETRY_MS = 25;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tryAcquire(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx");
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function acquire(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + TIMEOUT_MS;
  while (!tryAcquire(lockPath)) {
    // Break a leaked lock (holder crashed between create and unlink).
    // Best effort: the stat can race a concurrent release and the rm
    // can fail on permissions. Fall through to the deadline check
    // either way -- every loop iteration must reach it, or an
    // undeletable lock would spin this (synchronous, main-thread)
    // loop forever.
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // See above: the deadline below still bounds the loop.
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for file lock: ${lockPath}`);
    }
    sleepSync(RETRY_MS);
  }
}

export function withFileLock<T>(lockPath: string, fn: () => T): T {
  acquire(lockPath);
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
