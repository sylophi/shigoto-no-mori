// Atomic JSON read/write helpers used by globalConfig.ts and shigomori.ts.
// Both files keep their own caches; only the disk IO is shared here.
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";
import { isENOENT } from "./paths";
import { noteSelfWrite } from "./selfWrite";

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

// The version of the on-disk shape this build writes. Every file
// shigomori persists carries it: state.json, registry.json,
// config.json, projects/<id>/project.json and
// projects/<id>/worktrees/<id>.json. Nothing reads it to decide
// anything yet. It exists so a later format
// change can tell an old file from a new one instead of inferring the
// shape from whichever keys happen to be present. The CLI stamps the
// same key with the same value (cli/state.go). The two writers have to
// move together, since a marker the two disagree on is worse than no
// marker at all.
export const SCHEMA_VERSION = 1;

// Stamps the marker on a document about to be written. Always this
// build's constant, never whatever the file happened to carry: a
// writer that copied a higher number forward would be claiming a shape
// it has never produced, and full-replace writers (worktree data, the
// config `write --data` payload) don't have the old value in hand
// anyway, so copying it forward isn't a rule both writers could
// follow. Appended rather than placed first, so adding the key to an
// existing file moves nothing else around.
export function withSchemaVersion<T extends object>(
  value: T,
): T & { schemaVersion: number } {
  return { ...value, schemaVersion: SCHEMA_VERSION };
}

// The read side is deliberately toothless. Files written before the
// marker existed have none, which is normal and forever, and a file
// from a newer build is read exactly as it always was: refusing would
// strand anyone who launched a newer build once, over a field nothing
// consumes. It is still worth one line, because this build's next
// write stamps the file back down to SCHEMA_VERSION and nothing else
// would ever mention that. Once per file per run so the hot read paths
// can't turn it into a flood. Mirrored by noteNewerSchema in
// cli/state.go.
const newerSchemaNoted = new Set<string>();

export function noteNewerSchema(filePath: string, parsed: unknown): void {
  if (parsed === null || typeof parsed !== "object") return;
  const found = (parsed as Record<string, unknown>)["schemaVersion"];
  if (typeof found !== "number" || found <= SCHEMA_VERSION) return;
  if (newerSchemaNoted.has(filePath)) return;
  newerSchemaNoted.add(filePath);
  console.warn(
    `[shigomori] ${filePath} was written by a newer build ` +
      `(schemaVersion ${found}, this build writes ${SCHEMA_VERSION}). ` +
      "Reading it anyway.",
  );
}

export async function readJsonOrNull<T>(
  filePath: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    noteNewerSchema(filePath, parsed);
    return schema.parse(parsed);
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

// selfWrite: false is for control-plane files the state watcher ignores
// anyway (the updater bridge) -- claiming a self-write there would
// blind the watcher to genuine external state writes for the echo
// window around every updater transition.
export async function atomicWriteJson(
  filePath: string,
  value: unknown,
  { selfWrite = true }: { selfWrite?: boolean } = {},
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
  if (selfWrite) noteSelfWrite();
}
