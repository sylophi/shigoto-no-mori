// The merge behind shared settings (shared/schemas/sharedSettings.ts):
// pure functions over two copies of the document, shared by every
// place a copy lives (the host's registry.json, a browser's
// localStorage) and by the renderer that carries entries between them.
//
// Each entry is a last-writer-wins register. Merging is commutative,
// associative and idempotent, so copies may exchange entries in any
// order, any number of times, over any path, and still agree: there is
// no sync session to complete and nothing to resume.
import { z } from "zod";
import { isSafeRelPath } from "@shared/git/gitPaths";
import {
  MAX_SHARED_SETTING_ENTRIES,
  type SharedSettingEntry,
  type SharedSettingsDoc,
  type SharedSettingValue,
  SharedSettingValueSchema,
} from "@shared/schemas/sharedSettings";

export const EMPTY_SHARED_SETTINGS: SharedSettingsDoc = { entries: {} };

// The keys this build reads. Copies hold and forward any key, so a
// name here is a promise to every build that ever synced it: reuse one
// for a different meaning and older copies hand the old values back.
export const sharedSettingKeys = {
  // Which device a project header's + creates on, by repo identity
  // (the merged header IS the identity group). The value is a device
  // id.
  quickCreateDevice: (identity: string) => `quickCreateDevice/${identity}`,
  // What a mirror or transplant of the repo leaves out unless the
  // dialog says otherwise, by repo identity. The value is the whole
  // rule as one JSON string (leaveOutPresetValue): one entry a repo,
  // like every other key, so the rule's paths never spend the
  // document's entry budget, and a pick replaces the rule whole.
  leaveOutPreset: (identity: string) => `leaveOutPreset/${identity}`,
};

// The preset: the base in force and each base's exceptions as
// root-relative paths, both kept so a switch of base and back loses
// nothing, like the dialog's own selection. `leftOut` hangs off
// "everything" and `brought` off "gitignored".
// A path is read as leniently as the entries are: one this build would
// not hand the engine (it leaves the root, or is more than one line) is
// dropped and the rest of the rule still holds. It came off another
// device, and a bad one would fail every pull of the repo at Start.
const PresetPathsSchema = z
  .array(z.unknown())
  .transform((paths) =>
    paths.filter(
      (path): path is string =>
        typeof path === "string" &&
        path.length > 0 &&
        isSafeRelPath(path) &&
        !/[\r\n]/.test(path),
    ),
  )
  .default([]);
const LeaveOutPresetSchema = z.object({
  base: z.enum(["everything", "gitignored"]),
  leftOut: PresetPathsSchema,
  brought: PresetPathsSchema,
});
export type LeaveOutPreset = z.infer<typeof LeaveOutPresetSchema>;
export type LeaveOutPresetBase = LeaveOutPreset["base"];

// The dialogs' own default, nothing left out: what a repo with no
// preset (or one this build cannot read) opens on.
export const NO_LEAVE_OUT_PRESET: LeaveOutPreset = {
  base: "everything",
  leftOut: [],
  brought: [],
};

export function parseLeaveOutPreset(value: string | undefined): LeaveOutPreset {
  if (value === undefined) return NO_LEAVE_OUT_PRESET;
  try {
    const parsed = LeaveOutPresetSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : NO_LEAVE_OUT_PRESET;
  } catch {
    return NO_LEAVE_OUT_PRESET;
  }
}

// The preset as its entry's value, or null when the rule in force
// outgrows what a value holds. Paths sorted and empty lists left out,
// so the same rule is the same string and re-picking it is not a
// write. The other base's exceptions ride along only while there is
// room: they are off screen, and must never be why a rule is refused.
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
      (value) => SharedSettingValueSchema.safeParse(value).success,
    ) ?? null
  );
}

// Whether write `a` outranks write `b`: the later stamp, then the
// device id, an arbitrary order that is the same on every copy.
function outranks(a: SharedSettingEntry, b: SharedSettingEntry): boolean {
  return a.at !== b.at ? a.at > b.at : a.by > b.by;
}

// The stamp for a write made on a copy holding `doc`. Wall-clock time,
// but never at or below anything the copy has seen, so a write always
// outranks the value it replaces: a device whose clock runs behind its
// peers' would otherwise make picks that silently lose to the old one.
function nextSharedSettingStamp(doc: SharedSettingsDoc, now: number): number {
  let highest = 0;
  for (const entry of Object.values(doc.entries)) {
    if (entry.at > highest) highest = entry.at;
  }
  return Math.max(Math.floor(now), highest + 1);
}

// `base` with every entry of `incoming` that outranks its own. Returns
// `base` itself when nothing did, so a caller can tell a no-op merge
// from one worth persisting and announcing (which is what stops two
// copies from announcing the same state at each other forever).
export function mergeSharedSettings(
  base: SharedSettingsDoc,
  incoming: SharedSettingsDoc,
): SharedSettingsDoc {
  let entries: Record<string, SharedSettingEntry> | null = null;
  let count = Object.keys(base.entries).length;
  for (const [key, entry] of Object.entries(incoming.entries)) {
    const held = base.entries[key];
    if (held !== undefined && !outranks(entry, held)) continue;
    // A full copy keeps what it has and takes no new keys, rather than
    // growing past what the schema will read back.
    if (held === undefined) {
      if (count >= MAX_SHARED_SETTING_ENTRIES) continue;
      count += 1;
    }
    entries ??= { ...base.entries };
    entries[key] = entry;
  }
  return entries === null ? base : { entries };
}

// The entries of `from` that a copy holding `against` lacks or holds
// an older write of: what is worth offering it.
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

// `doc` with one setting written by `deviceId` now. Re-picking the
// value already held is not a write and answers `doc` itself, like a
// merge that learned nothing: a fresh stamp for it would outrank a
// different pick made elsewhere meanwhile.
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

// A string setting's value, or undefined when unset, cleared, or
// written as something else by a build that meant something else.
export function sharedStringSetting(
  doc: SharedSettingsDoc | undefined,
  key: string,
): string | undefined {
  const value = doc?.entries[key]?.value;
  return typeof value === "string" ? value : undefined;
}

// Where a copy is kept. `transact` runs `next` on the stored copy
// atomically (under the registry lock on a host) and stores its answer
// unless that is undefined.
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
  // Drops the whole copy, for a device leaving the account (the peers
  // hand it back on the first exchange after a re-sign-in). Announced
  // like any change. Not tombstone writes: those would outrank the
  // peers' entries and clear the account's picks everywhere.
  clear(): SharedSettingsDoc;
};

// One device's copy, over whatever holds it. The rule every copy has to
// keep lives here once: a write or a merge that changes nothing stores
// nothing and announces nothing, which is what ends an exchange (two
// copies that announced no-ops would answer each other forever).
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
    // Most merges learn nothing (every copy announces to every other,
    // so a pick comes back round as an echo), and those are settled off
    // a plain read without opening a transaction.
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
      // Resolved up front so `next` stays pure: it runs twice, the
      // second time inside the storage's lock.
      const deviceId = opts.deviceId();
      const now = Date.now();
      const doc = update((current) =>
        withSharedSetting(current, key, value, deviceId, now),
      );
      // A full copy takes no new keys. Said out loud, or the pick would
      // read as made and quietly not hold.
      if (doc.entries[key]?.value !== value) {
        throw new Error("Shared settings are full on this device.");
      }
      return doc;
    },
  };
}

// The two calls an exchange needs of a copy, local or a peer's.
export type SharedSettingsEndpoint = {
  read(): Promise<SharedSettingsDoc>;
  merge(doc: SharedSettingsDoc): Promise<SharedSettingsDoc>;
};

// One exchange with a peer: take what it holds, then offer back what
// it lacks. Rejects when the peer cannot be read, or refuses the offer
// (it accepts no commands), and the caller decides what that is worth.
export async function exchangeSharedSettings(
  mine: Pick<SharedSettingsEndpoint, "merge">,
  theirs: SharedSettingsEndpoint,
): Promise<void> {
  const held = await theirs.read();
  const merged = await mine.merge(held);
  const ahead = sharedSettingsAhead(merged, held);
  if (Object.keys(ahead.entries).length > 0) await theirs.merge(ahead);
}
