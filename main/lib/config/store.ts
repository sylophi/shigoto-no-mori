// Tiny JSON-file persistence in the shigomori root. Atomic via tmp+rename.
// Writes are read-modify-write of the whole file, and both the app and
// the CLI go through this module -- so every write cycle holds the
// cross-process lock. Reads stay lock-free: the rename keeps the file
// itself always consistent.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  noteNewerSchema,
  tempPathFor,
  withSchemaVersion,
} from "../util/jsonFile";
import { withFileLock } from "../util/lockFile";
import { isENOENT, shigomoriRoot } from "../util/paths";
import { noteSelfWrite } from "../util/selfWrite";

const FILE = "state.json";

function filePath(): string {
  return join(shigomoriRoot(), FILE);
}

// Every write is a read-modify-write of the whole file, so "I couldn't
// read it" must never come back as "it's empty": a permission error, an
// IO error or a cloud file that hasn't been materialized would rewrite
// state.json with nothing but the key being written, dropping the
// project registry, the shelf, and every use log. Only a genuinely
// absent file is empty. Everything else throws, which aborts the write
// with the file still on disk. The CLI's readStateFile does the same.
function readAll(): Record<string, unknown> {
  const path = filePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isENOENT(error)) return {};
    throw new Error(`Failed to read ${path}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(corruptMessage(path), { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(corruptMessage(path));
  }
  noteNewerSchema(path, parsed);
  return parsed as Record<string, unknown>;
}

// A truncated or hand-mangled state.json is the one case where a blind
// rewrite destroys something recoverable, so refuse and name the file
// rather than moving it aside and starting fresh. Quarantining would
// leave the user staring at an empty app with their data in a file
// they never asked for.
function corruptMessage(path: string): string {
  return (
    `${path} is not a valid JSON object. Nothing was written. ` +
    "Fix the file or move it aside, then try again."
  );
}

// withSchemaVersion on the way out rather than on the way in: readAll
// hands its result to callers that only want their own key, and the
// marker belongs to the file, not to the data. Every write goes
// through here, so the file is stamped whatever the caller was doing.
function writeAll(data: Record<string, unknown>): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  writeFileSync(tmp, JSON.stringify(withSchemaVersion(data), null, 2), "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort; the stray tmp file is harmless.
    }
    throw error;
  }
  noteSelfWrite();
}

export function readKey<T>(key: string, fallback: T): T {
  const all = readAll();
  if (key in all) return all[key] as T;
  return fallback;
}

export function writeKey<T>(key: string, value: T): void {
  withFileLock(`${filePath()}.lock`, () => {
    const all = readAll();
    all[key] = value;
    writeAll(all);
  });
}

// Read-modify-write of one key with the READ inside the lock. Callers
// that derive the new value from the current one (append a project,
// toggle a shelf flag) must use this instead of readKey + writeKey:
// with the read outside the lock, a concurrent CLI write between the
// read and the write is silently clobbered. `update` may return
// undefined to skip the write (no-op detected under the lock). It may
// also throw (e.g. a duplicate check); the lock is still released.
export function updateKey<T>(
  key: string,
  fallback: T,
  update: (current: T) => T | undefined,
): void {
  withFileLock(`${filePath()}.lock`, () => {
    const all = readAll();
    const current = key in all ? (all[key] as T) : fallback;
    const next = update(current);
    if (next === undefined) return;
    all[key] = next;
    writeAll(all);
  });
}
