// Atomic JSON read/write helpers used by globalConfig.ts and shigomori.ts.
// Both files keep their own caches; only the disk IO is shared here.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { isENOENT } from "./paths";

// Best-effort delete: callers fire this on lifecycle events and shouldn't
// fail just because the file never existed. Used by both the worktree-state
// cleanup paths and the atomic-write tmp rollback.
export async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

export async function readJsonOrNull<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return schema.parse(JSON.parse(raw));
  } catch (error) {
    if (isENOENT(error)) return null;
    throw new Error(`Failed to read ${filePath}`, { cause: error });
  }
}

// Monotonic counter so two parallel callers can't pick the same tmp
// name. `Date.now()` (ms resolution) alone collides when N writers fan
// out within a single tick: both writeFile the same path, the first's
// rename consumes the tmp, and the second's rename fails ENOENT. The
// pid guards the cross-process case (a second app instance). Shared
// with the sync writer in config/store.ts.
let tempCounter = 0;

export function tempPathFor(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${tempCounter++}`;
}

export async function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temp = tempPathFor(filePath);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temp, filePath);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
