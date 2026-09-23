// Tiny JSON-file persistence in the shigomori data dir. Atomic via tmp+rename.
// Writes are read-modify-write of the whole file, and both the app and
// the CLI go through this module, so every write cycle holds the
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { errorMessageOf } from "@shared/errors";
import { type AnyCodec, safeDecodeWith } from "@shared/ipc/codec";
import {
  PackageScriptSortModeSchema,
  ProjectSchema,
  ProjectSortModeSchema,
  SharedSettingsDocSchema,
} from "@shared/schemas";
import {
  atomicWriteJsonSync,
  noteNewerSchema,
  withSchemaVersion,
} from "../util/jsonFile";
import { withFileLock } from "../util/lockFile";
import { dataDir, isENOENT, REGISTRY_FILE, STATE_FILE } from "../util/paths";

// The registry's keys live here rather than in their feature modules
// so the accessors and the split below can't drift apart. cli/state.go
// names the same set.
export const PROJECTS_KEY = "projects";
export const SHELVED_KEY = "shelvedWorktrees";
// UUID naming this data dir, not this machine: a dev data dir and a
// prod data dir on one laptop are two devices. Generated on first read by
// host/lib/config/deviceId.ts. The CLI only preserves it.
export const DEVICE_ID_KEY = "deviceId";
// This device's copy of the shared settings
// (host/lib/sharedSettings/store.ts). App-written like deviceId: the
// CLI never reads it and only preserves it.
export const SHARED_SETTINGS_KEY = "sharedSettings";
// Worktree ids that fast-forward from their upstream on the app's own
// fetch cadence (host/lib/worktrees/autoPull.ts). Written by the app
// and the CLI alike (cli/state.go autoPullKey).
export const AUTO_PULL_KEY = "autoPullWorktrees";

// state.json's keys, named here beside their shapes below. The feature
// modules that own them (projects/usage.ts, projects/collapsed.ts,
// scripts/packageScriptStats.ts, ipc/modules/launchers.ts) spell the
// same strings, and cli/state.go the ones it writes too.
export const PROJECT_USE_LOG_KEY = "projectUseLog";
export const LAUNCHER_USE_LOG_KEY = "launcherUseLog";
export const PACKAGE_SCRIPT_USE_LOG_KEY = "packageScriptUseLog";
export const PROJECTS_SORT_KEY = "projectsSort";
export const PACKAGE_SCRIPT_SORT_KEY = "packageScriptSort";
export const PROJECTS_COLLAPSED_KEY = "projectsCollapsed";

// Drives only the state.json→registry.json split below. deviceId is
// deliberately absent because it postdates the split, so no old-format
// data dir holds one.
const REGISTRY_KEYS = [PROJECTS_KEY, SHELVED_KEY];

// --- what each key holds ---
//
// Both files are hand-editable and shared with the CLI, so a value is
// decoded against its shape on the way out of readAll rather than cast.
// The decode is per key, never per document: a mangled sort preference
// must not make the project list unreadable, and a key this build does
// not model (a newer build's, the CLI's) is never looked at, so it rides
// through every read-modify-write untouched. A project row is loose for
// the same reason: a field this build does not model survives a
// reorder, which rewrites the whole list.
//
// What a malformed value does depends on who owns the repair:
//
// - "refuse": the strict read (readKey, and updateKey's read under the
//   lock) throws, naming the file and the key, and readHint answers its
//   fallback. A write must never rebuild the value out of a fallback,
//   because the fallback is "nothing": the CLI's decodeKey refuses the
//   same way (cli/state.go).
// - "absent": the value reads as missing, on every path. For keys whose
//   owner already self-heals a bad value on its next write (the device
//   id is re-minted under the lock, the shared settings refill from the
//   next peer merge, the collapse set degrades to nothing folded), where
//   refusing would turn a repairable value into a stuck error.

// A project row as stored: the declared fields decode, every other key
// rides through (config.ts's loose()).
const StoredProjectSchema = Schema.StructWithRest(ProjectSchema, [
  Schema.Record(Schema.String, Schema.Unknown),
]);
// A worktree id set (the shelf, the auto-pull marks). Written as
// id -> true; cli/state.go reads it as map[string]bool.
const IdMarksSchema = Schema.Record(Schema.String, Schema.Boolean);
// id -> action timestamps, the rolling window util/useLog.ts keeps.
const UseLogSchema = Schema.Record(Schema.String, Schema.Array(Schema.Number));
// The GUID shape, any version: the id is minted by randomUUID, and an
// older mint must keep reading as valid.
export const DeviceIdSchema = Schema.String.check(Schema.isGUID());

type KeyRule = { schema: AnyCodec; malformed: "refuse" | "absent" };
const refuse = (schema: AnyCodec): KeyRule => ({ schema, malformed: "refuse" });
const absent = (schema: AnyCodec): KeyRule => ({ schema, malformed: "absent" });

const REGISTRY_RULES: Readonly<Record<string, KeyRule>> = {
  [PROJECTS_KEY]: refuse(Schema.Array(StoredProjectSchema)),
  [SHELVED_KEY]: refuse(IdMarksSchema),
  [AUTO_PULL_KEY]: refuse(IdMarksSchema),
  [DEVICE_ID_KEY]: absent(DeviceIdSchema),
  [SHARED_SETTINGS_KEY]: absent(SharedSettingsDocSchema),
};

const STATE_RULES: Readonly<Record<string, KeyRule>> = {
  [PROJECT_USE_LOG_KEY]: refuse(UseLogSchema),
  [LAUNCHER_USE_LOG_KEY]: refuse(UseLogSchema),
  [PACKAGE_SCRIPT_USE_LOG_KEY]: refuse(
    Schema.Record(Schema.String, UseLogSchema),
  ),
  [PROJECTS_SORT_KEY]: refuse(ProjectSortModeSchema),
  [PACKAGE_SCRIPT_SORT_KEY]: refuse(
    Schema.Record(Schema.String, PackageScriptSortModeSchema),
  ),
  [PROJECTS_COLLAPSED_KEY]: absent(Schema.Array(Schema.String)),
};

const RULES: Readonly<Record<string, Readonly<Record<string, KeyRule>>>> = {
  [REGISTRY_FILE]: REGISTRY_RULES,
  [STATE_FILE]: STATE_RULES,
};

// A key's value as read, decoded against its rule. `found` is false
// when the key is missing, or holds a malformed "absent" value; a
// malformed "refuse" value throws. A key with no rule is handed over as
// stored.
function decodeKey(
  file: string,
  all: Record<string, unknown>,
  key: string,
): { found: false } | { found: true; value: unknown } {
  if (!(key in all)) return { found: false };
  const rule = RULES[file]?.[key];
  if (rule === undefined) return { found: true, value: all[key] };
  const decoded = safeDecodeWith(rule.schema, all[key]);
  if (decoded.success) return { found: true, value: decoded.data };
  if (rule.malformed === "absent") return { found: false };
  throw new Error(
    `${filePath(file)} holds a malformed "${key}" value ` +
      `(${errorMessageOf(decoded.error)}). Nothing was written. ` +
      "Fix the file or move it aside, then try again.",
    { cause: decoded.error },
  );
}

function filePath(file: string): string {
  return join(dataDir(), file);
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
  atomicWriteJsonSync(filePath(file), withSchemaVersion(data));
}

function withStoreLock<T>(file: string, fn: () => T): T {
  return withFileLock(`${filePath(file)}.lock`, fn);
}

// The casts below are the store's generic surface: the value was
// decoded against the key's rule, and the caller names the type that
// rule's schema produces.
function readKeyIn<T>(file: string, key: string, fallback: T): T {
  const read = decodeKey(file, readAll(file), key);
  return read.found ? (read.value as T) : fallback;
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
    const read = decodeKey(file, all, key);
    const current = read.found ? (read.value as T) : fallback;
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
  console.warn(
    `[store] ${file} unreadable, falling back: ${errorMessageOf(error)}`,
  );
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
// whether an old-format data dir has to be drained before the first touch.
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
// old-format data dir first, so no caller has to know the split happened.
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
// Two processes starting against the same old data dir are safe because
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
