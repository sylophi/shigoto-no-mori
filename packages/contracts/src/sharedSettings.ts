// Each entry is a last-writer-wins register. Merging is commutative,
// associative and idempotent, so copies may exchange entries in any
// order, any number of times, over any path, and still agree.
import { isSafeRelPath } from "./predicates/relPath.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import {
  MAX_SHARED_SETTING_ENTRIES,
  type SharedSettingEntry,
  type SharedSettingsDoc,
  type SharedSettingValue,
  SharedSettingValueSchema,
} from "./schemas/sharedSettings.ts";

const isSharedSettingValue = Schema.is(SharedSettingValueSchema);

export const EMPTY_SHARED_SETTINGS: SharedSettingsDoc = { entries: {} };

const PINNED_PROJECT_PREFIX = "pinnedProject/";
const WORKTREE_SORT_PREFIX = "worktreeSort/";

// The keys this build reads. Copies hold and forward any key, so a
// name here is a promise to every build that ever synced it: reuse one
// for a different meaning and older copies hand the old values back.

export const sharedSettingKeys = {
  // A device id.
  quickCreateDevice: (identity: string) => `quickCreateDevice/${identity}`,
  // The whole rule as one JSON string, so its paths never spend the
  // document's entry budget.
  leaveOutPreset: (identity: string) => `leaveOutPreset/${identity}`,
  // A WorktreeSortMode.
  worktreeSort: (groupKey: string) => `${WORKTREE_SORT_PREFIX}${groupKey}`,
  // true, or null once unpinned.
  pinnedProject: (groupKey: string) => `${PINNED_PROJECT_PREFIX}${groupKey}`,
  // Prefixes, one per line.
  hiddenWorktreePrefixes: "hiddenWorktreePrefixes",
  // Prefixes, one per line.
  groupedWorktreePrefixes: "groupedWorktreePrefixes",
};

// So the same list is the same value.
export function normalizeWorktreePrefixes(
  prefixes: readonly string[],
): string[] {
  const trimmed = prefixes.map((prefix) => prefix.trim()).filter(Boolean);
  return [...new Set(trimmed)].toSorted();
}

export function parseWorktreePrefixes(value: string | undefined): string[] {
  return value === undefined
    ? []
    : normalizeWorktreePrefixes(value.split("\n"));
}

// Null when they outgrow what a value holds.
export function worktreePrefixesValue(
  prefixes: readonly string[],
): string | null {
  const value = normalizeWorktreePrefixes(prefixes).join("\n");
  return isSharedSettingValue(value) ? value : null;
}

// A primary is never matched. A detached worktree's branch is a hash.
type PrefixedWorktree = {
  name: string;
  branch: string;
  isPrimary: boolean;
  detached: boolean;
};

function startsWithPrefix(worktree: PrefixedWorktree, prefix: string) {
  return (
    worktree.name.startsWith(prefix) ||
    (!worktree.detached && worktree.branch.startsWith(prefix))
  );
}

export function isHiddenByPrefix(
  worktree: PrefixedWorktree,
  prefixes: readonly string[],
): boolean {
  if (worktree.isPrimary) return false;
  return prefixes.some((prefix) => startsWithPrefix(worktree, prefix));
}

// The longest match wins, so `v3/` and `v3/ui/` can both be groups.
export function groupPrefixOf(
  worktree: PrefixedWorktree,
  prefixes: readonly string[],
): string | null {
  if (worktree.isPrimary) return null;
  let best: string | null = null;
  for (const prefix of prefixes) {
    if (
      startsWithPrefix(worktree, prefix) &&
      prefix.length > (best?.length ?? 0)
    )
      best = prefix;
  }
  return best;
}

// Both bases' exceptions are kept, so a switch of base and back loses
// nothing. A path this build wouldn't hand the engine is dropped and the
// rest still holds: it came off another device, and would otherwise fail
// every pull of the repo.
const isPresetPath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.length > 0 &&
  isSafeRelPath(path) &&
  !/[\r\n]/.test(path);
const PresetPathsSchema = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform<readonly string[], readonly unknown[]>({
      decode: (paths) => paths.filter(isPresetPath),
      encode: (paths) => paths,
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed([])),
);
const LeaveOutPresetSchema = Schema.Struct({
  base: Schema.Literals(["everything", "gitignored"]),
  leftOut: PresetPathsSchema,
  brought: PresetPathsSchema,
});
export type LeaveOutPreset = typeof LeaveOutPresetSchema.Type;
const decodeLeaveOutPreset = Schema.decodeUnknownOption(LeaveOutPresetSchema);
export type LeaveOutPresetBase = LeaveOutPreset["base"];

export const NO_LEAVE_OUT_PRESET: LeaveOutPreset = {
  base: "everything",
  leftOut: [],
  brought: [],
};

export function parseLeaveOutPreset(value: string | undefined): LeaveOutPreset {
  if (value === undefined) return NO_LEAVE_OUT_PRESET;
  try {
    return Option.getOrElse(
      decodeLeaveOutPreset(JSON.parse(value)),
      () => NO_LEAVE_OUT_PRESET,
    );
  } catch {
    return NO_LEAVE_OUT_PRESET;
  }
}

// Sorted, so re-picking the same rule isn't a write. The other base's
// exceptions ride only while there is room: they must never be why a
// rule is refused.
export function leaveOutPresetValue(preset: LeaveOutPreset): string | null {
  const inForce = preset.base === "everything" ? "leftOut" : "brought";
  const encode = (kept: ReadonlyArray<"leftOut" | "brought">) =>
    JSON.stringify({
      base: preset.base,
      ...Object.fromEntries(
        kept
          .filter((list) => preset[list].length > 0)
          .map((list) => [list, preset[list].toSorted()]),
      ),
    });
  return (
    [encode(["leftOut", "brought"]), encode([inForce])].find(
      isSharedSettingValue,
    ) ?? null
  );
}

// The later stamp, then the device id: arbitrary, but the same on every
// copy.
function outranks(a: SharedSettingEntry, b: SharedSettingEntry): boolean {
  return a.at !== b.at ? a.at > b.at : a.by > b.by;
}

// Never at or below anything the copy has seen: a device whose clock
// runs behind would otherwise make picks that silently lose.
function nextSharedSettingStamp(doc: SharedSettingsDoc, now: number): number {
  let highest = 0;
  for (const entry of Object.values(doc.entries)) {
    if (entry.at > highest) highest = entry.at;
  }
  return Math.max(Math.floor(now), highest + 1);
}

// Answers `base` itself when nothing changed, which is what stops two
// copies announcing the same state at each other forever.
export function mergeSharedSettings(
  base: SharedSettingsDoc,
  incoming: SharedSettingsDoc,
): SharedSettingsDoc {
  let entries: Record<string, SharedSettingEntry> | null = null;
  let count = Object.keys(base.entries).length;
  for (const [key, entry] of Object.entries(incoming.entries)) {
    const held = base.entries[key];
    if (held !== undefined && !outranks(entry, held)) continue;
    // A full copy takes no new keys, or the schema wouldn't read it back.
    if (held === undefined) {
      if (count >= MAX_SHARED_SETTING_ENTRIES) continue;
      count += 1;
    }
    entries ??= { ...base.entries };
    entries[key] = entry;
  }
  return entries === null ? base : { entries };
}

export function sharedSettingsAhead(
  from: SharedSettingsDoc,
  against: SharedSettingsDoc,
): SharedSettingsDoc {
  const entries: Record<string, SharedSettingEntry> = {};
  for (const [key, entry] of Object.entries(from.entries)) {
    const held = against.entries[key];
    if (held === undefined || outranks(entry, held)) entries[key] = entry;
  }
  return { entries };
}

// Re-picking the held value is not a write: a fresh stamp would outrank
// a different pick made elsewhere meanwhile.
export function withSharedSetting(
  doc: SharedSettingsDoc,
  key: string,
  value: SharedSettingValue,
  deviceId: string,
  now: number,
): SharedSettingsDoc {
  if (doc.entries[key]?.value === value) return doc;
  return mergeSharedSettings(doc, {
    entries: {
      [key]: { value, at: nextSharedSettingStamp(doc, now), by: deviceId },
    },
  });
}

export function sharedStringSetting(
  doc: SharedSettingsDoc | undefined,
  key: string,
): string | undefined {
  const value = doc?.entries[key]?.value;
  return typeof value === "string" ? value : undefined;
}

function entriesUnder(
  doc: SharedSettingsDoc,
  prefix: string,
): [string, SharedSettingValue][] {
  return Object.entries(doc.entries)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, entry]) => [key.slice(prefix.length), entry.value]);
}

export function pinnedProjectKeys(doc: SharedSettingsDoc): string[] {
  return entriesUnder(doc, PINNED_PROJECT_PREFIX)
    .filter(([, value]) => value === true)
    .map(([groupKey]) => groupKey)
    .toSorted();
}

export function worktreeSortValues(doc: SharedSettingsDoc): [string, string][] {
  return entriesUnder(doc, WORKTREE_SORT_PREFIX).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

// `transact` stores `next`'s answer atomically unless it is undefined.
export type SharedSettingsStorage = {
  read(): SharedSettingsDoc;
  transact(
    next: (current: SharedSettingsDoc) => SharedSettingsDoc | undefined,
  ): void;
};

export type SharedSettingsCopy = {
  read(): SharedSettingsDoc;
  set(key: string, value: SharedSettingValue): SharedSettingsDoc;
  merge(incoming: SharedSettingsDoc): SharedSettingsDoc;
  // For a device leaving the account. Not tombstones: those would
  // outrank the peers' entries and clear the picks everywhere.
  clear(): SharedSettingsDoc;
};

// A write or merge that changes nothing stores and announces nothing,
// which is what ends an exchange.
export function createSharedSettingsCopy(
  storage: SharedSettingsStorage,
  opts: {
    deviceId: () => string;
    announce: (doc: SharedSettingsDoc) => void;
  },
): SharedSettingsCopy {
  function update(
    next: (current: SharedSettingsDoc) => SharedSettingsDoc,
  ): SharedSettingsDoc {
    // Most merges are echoes, settled off a plain read without a
    // transaction.
    const seen = storage.read();
    if (next(seen) === seen) return seen;
    let result = seen;
    let changed = false;
    storage.transact((current) => {
      result = next(current);
      changed = result !== current;
      return changed ? result : undefined;
    });
    if (changed) opts.announce(result);
    return result;
  }
  return {
    read: () => storage.read(),
    merge: (incoming) =>
      update((current) => mergeSharedSettings(current, incoming)),
    clear: () =>
      update((current) =>
        Object.keys(current.entries).length === 0
          ? current
          : EMPTY_SHARED_SETTINGS,
      ),
    set: (key, value) => {
      // Up front, so `next` stays pure: it runs twice.
      const deviceId = opts.deviceId();
      const now = Date.now();
      const doc = update((current) =>
        withSharedSetting(current, key, value, deviceId, now),
      );
      if (doc.entries[key]?.value !== value) {
        throw new Error("Shared settings are full on this device.");
      }
      return doc;
    },
  };
}

export type SharedSettingsEndpoint = {
  read(): Promise<SharedSettingsDoc>;
  merge(input: { doc: SharedSettingsDoc }): Promise<SharedSettingsDoc>;
};

// Take what the peer holds, then offer back what it lacks.
export async function exchangeSharedSettings(
  mine: Pick<SharedSettingsEndpoint, "merge">,
  theirs: SharedSettingsEndpoint,
): Promise<void> {
  const held = await theirs.read();
  const merged = await mine.merge({ doc: held });
  const ahead = sharedSettingsAhead(merged, held);
  if (Object.keys(ahead.entries).length > 0) await theirs.merge({ doc: ahead });
}
