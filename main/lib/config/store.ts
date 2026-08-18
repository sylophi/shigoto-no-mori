// Tiny JSON-file persistence in the shigomori root. Atomic via tmp+rename.
// Writes are read-modify-write of the whole file, and both the app and
// the CLI go through this module -- so every write cycle holds the
// cross-process lock. Reads stay lock-free: the rename keeps the file
// itself always consistent.
//
// Two files, split by what it costs to lose them. registry.json holds
// the durable record of what the user has set up: the project list and
// the worktree shelf. state.json holds what the app can rebuild by
// being used: the three use logs, the two sort preferences and the
// sidebar collapse set. The registry is only rewritten when projects
// or the shelf actually change, so the writes that fire on nearly
// every click never touch it.
import {
  existsSync,
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

const STATE_FILE = "state.json";
const REGISTRY_FILE = "registry.json";

// The registry's two keys live here rather than in their feature
// modules so the accessors and the split below can't drift apart.
// cli/state.go names the same two.
export const PROJECTS_KEY = "projects";
export const SHELVED_KEY = "shelvedWorktrees";

const REGISTRY_KEYS = [PROJECTS_KEY, SHELVED_KEY];

function filePath(file: string): string {
  return join(shigomoriRoot(), file);
}

// Every write is a read-modify-write of the whole file, so "I couldn't
// read it" must never come back as "it's empty": a permission error, an
// IO error or a cloud file that hasn't been materialized would rewrite
// the file with nothing but the key being written, dropping the project
// registry or every use log. Only a genuinely absent file is empty.
// Everything else throws, which aborts the write with the file still on
// disk. The CLI's readJsonObject does the same.
function readAll(file: string): Record<string, unknown> {
  const path = filePath(file);
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

// A truncated or hand-mangled file is the one case where a blind
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
function writeAll(file: string, data: Record<string, unknown>): void {
  const path = filePath(file);
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

function withStoreLock<T>(file: string, fn: () => T): T {
  return withFileLock(`${filePath(file)}.lock`, fn);
}

function readKeyIn<T>(file: string, key: string, fallback: T): T {
  const all = readAll(file);
  if (key in all) return all[key] as T;
  return fallback;
}

function writeKeyIn<T>(file: string, key: string, value: T): void {
  withStoreLock(file, () => {
    const all = readAll(file);
    all[key] = value;
    writeAll(file, all);
  });
}

function updateKeyIn<T>(
  file: string,
  key: string,
  fallback: T,
  update: (current: T) => T | undefined,
): void {
  withStoreLock(file, () => {
    const all = readAll(file);
    const current = key in all ? (all[key] as T) : fallback;
    const next = update(current);
    if (next === undefined) return;
    all[key] = next;
    writeAll(file, all);
  });
}

// One line per file per app run. The reads that land here run on every
// sidebar render and every refetch, so a file that stays broken would
// otherwise log forever. The CLI dedupes the same way, in
// noteFileTrouble.
const hintFailureLogged = new Set<string>();

function noteHintFailure(file: string, error: unknown): void {
  if (hintFailureLogged.has(file)) return;
  hintFailureLogged.add(file);
  console.warn(`[store] ${file} unreadable, falling back:`, error);
}

interface JsonStore {
  readKey<T>(key: string, fallback: T): T;
  // readKey for display-only reads. The strict read is what stops a
  // write from rebuilding the file out of nothing, and that guarantee
  // belongs to writes: a reader whose whole loss is a missing badge or
  // a forgotten sort order should let the view render instead of
  // taking it down. A read that feeds a later write is not one of
  // these, and stays on readKey.
  readHint<T>(key: string, fallback: T): T;
  writeKey<T>(key: string, value: T): void;
  // Read-modify-write of one key with the READ inside the lock. Callers
  // that derive the new value from the current one (append a project,
  // toggle a shelf flag) must use this instead of readKey + writeKey:
  // with the read outside the lock, a concurrent CLI write between the
  // read and the write is silently clobbered. `update` may return
  // undefined to skip the write (no-op detected under the lock). It may
  // also throw (e.g. a duplicate check); the lock is still released.
  updateKey<T>(
    key: string,
    fallback: T,
    update: (current: T) => T | undefined,
  ): void;
}

// The two stores say exactly two things: which file they own, and
// whether an old-format root has to be drained before the first touch.
// Generated from those two rather than written out twice, so a method
// can't gain a rule on one store and miss it on the other.
function makeStore(file: string, beforeAccess?: () => void): JsonStore {
  const enter = beforeAccess ?? (() => {});
  return {
    readKey<T>(key: string, fallback: T): T {
      enter();
      return readKeyIn(file, key, fallback);
    },
    readHint<T>(key: string, fallback: T): T {
      try {
        enter();
        return readKeyIn(file, key, fallback);
      } catch (error) {
        noteHintFailure(file, error);
        return fallback;
      }
    },
    writeKey<T>(key: string, value: T): void {
      enter();
      writeKeyIn(file, key, value);
    },
    updateKey<T>(
      key: string,
      fallback: T,
      update: (current: T) => T | undefined,
    ): void {
      enter();
      updateKeyIn(file, key, fallback, update);
    },
  };
}

// Use logs, sort preferences, sidebar collapse set.
export const stateStore = makeStore(STATE_FILE);

// Project list and worktree shelf. Every entry point drains an
// old-format root first, so no caller has to know the split happened.
export const registryStore = makeStore(REGISTRY_FILE, ensureRegistrySplit);

// --- one-time move of the registry keys out of state.json ---
//
// Roots written by an earlier build keep the project list and the shelf
// in state.json. The first registry access in each process drains them
// into registry.json. Mirrored by ensureRegistrySplit in cli/state.go,
// which has to agree with this down to the file name and the key names.
//
// The write order is the whole safety argument. registry.json is
// written first and state.json is stripped second, both atomic
// renames, so a crash between them leaves the data in two places
// rather than in none. A key present in registry.json always wins:
// that file is the live copy the moment it exists.
//
// That is also why the check below is a stat and not a read. Once
// registry.json is there, reads are already correct and the state.json
// read could only ever report nothing left to move. A crash in the
// window between the two writes does leave a stale copy of the keys
// behind in state.json, and it stays there. Nothing reads it: the
// registry keys are only ever read from registry.json, and state.json
// is only ever asked for the keys it owns.
//
// Two processes starting against the same old root are safe because
// state.json is read again inside its lock. The loser of the race
// finds nothing left to move and writes nothing. Both locks are taken,
// state.json's outside registry.json's. Nothing else takes both, so
// the order can't deadlock.
let registrySplitDone = false;

function ensureRegistrySplit(): void {
  if (registrySplitDone) return;
  if (existsSync(filePath(REGISTRY_FILE))) {
    registrySplitDone = true;
    return;
  }
  // An unreadable state.json throws from here with no registry.json to
  // read instead, so the registry is genuinely unknown. Answering "no
  // projects" is the failure the strict read exists to prevent.
  const state = readAll(STATE_FILE);
  if (!REGISTRY_KEYS.some((key) => key in state)) {
    registrySplitDone = true;
    return;
  }
  withStoreLock(STATE_FILE, () => {
    const current = readAll(STATE_FILE);
    const moving = REGISTRY_KEYS.filter((key) => key in current);
    if (moving.length === 0) return;
    withStoreLock(REGISTRY_FILE, () => {
      const registry = readAll(REGISTRY_FILE);
      const adding = moving.filter((key) => !(key in registry));
      if (adding.length === 0) return;
      for (const key of adding) registry[key] = current[key];
      writeAll(REGISTRY_FILE, registry);
    });
    for (const key of moving) delete current[key];
    writeAll(STATE_FILE, current);
  });
  registrySplitDone = true;
}
