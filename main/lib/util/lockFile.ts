// Advisory cross-process file lock for read-modify-write cycles on
// shared JSON state. The app and the sgm CLI can both mutate
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
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) {
        // Leaked by a crashed holder; break it and race for the retake.
        rmSync(lockPath, { force: true });
        continue;
      }
    } catch {
      // Holder released between our create attempt and the stat; retry.
      continue;
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
