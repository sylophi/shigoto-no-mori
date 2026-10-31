// The start after a nuke (the shells' nuke writes the marker:
// main/electron/nuke.ts, headless/nuke.ts): electron-free, so the
// headless host and a proof under plain node (test/nuke.mts) drive it
// too. It deletes what the marker names and everything in userData, the
// marker last, so a start that dies halfway through finds the marker
// and deletes the rest.
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { errorMessageOf } from "@shigomori/contracts/errors";
import { DEV_PROFILES_DIR } from "@shared/packaging/appName.mts";
import {
  dataDir,
  dataDirPointerPath,
  dataDirSource,
  legacyDataDirPointerPath,
} from "@shared/paths";

export const NUKE_MARKER = "nuke.pending";

// What goes at the next start besides userData: the data dir, the logs,
// and the pointer that found the data dir. A data dir set by
// SHIGOMORI_DATA_DIR (a dev profile) came from no pointer, and the
// flavor's pointer is another instance's then.
export function nukedPaths(logs: string): string[] {
  const pointers =
    dataDirSource() === "env"
      ? []
      : [dataDirPointerPath(), legacyDataDirPointerPath()];
  return [dataDir(), logs, ...pointers.filter((path) => path !== null)];
}

// Deletes `path` whole, or as much of it as goes: a folder that won't
// go says only that it isn't empty, so what stayed in it is found by
// deleting its entries one by one, each named with why.
function remove(path: string, left: { path: string; why: string }[]): void {
  try {
    rmSync(path, { recursive: true, force: true });
    return;
  } catch (error) {
    let entries: string[] | null = null;
    try {
      if (lstatSync(path).isDirectory()) entries = readdirSync(path);
    } catch {
      // Unreadable: named as it is.
    }
    if (entries === null) {
      left.push({ path, why: reasonOf(error) });
      return;
    }
    const before = left.length;
    for (const entry of entries) remove(join(path, entry), left);
    if (left.length > before) return;
    try {
      rmdirSync(path);
    } catch (folderError) {
      left.push({ path, why: reasonOf(folderError) });
    }
  }
}

const reasonOf = (error: unknown): string =>
  REASONS[Predicate.hasProperty(error, "code") ? String(error.code) : ""] ??
  errorMessageOf(error);

// Why a file stayed, for the person who deletes it.
const REASONS: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "not permitted (a locked file?)",
  EBUSY: "in use",
  EROFS: "on a read-only volume",
};

const NukeMarkerSchema = Schema.Struct({
  // Each a file or a folder, deleted whole.
  paths: Schema.Array(Schema.String),
});
const decodeMarker = Schema.decodeUnknownOption(
  Schema.fromJsonString(NukeMarkerSchema),
);

// Written beside itself and renamed in once on disk, so a start finds
// the whole marker or none: a torn one would read as naming nothing.
export function writeNukeMarker(
  userData: string,
  paths: readonly string[],
): void {
  const marker = join(userData, NUKE_MARKER);
  const staged = `${marker}.tmp`;
  const fd = openSync(staged, "w");
  try {
    writeSync(fd, JSON.stringify({ paths }));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staged, marker);
}

// What a start that found a marker couldn't delete, and why, or null
// for no marker. The lock's own files stay, since this process holds the
// lock through them, and so do the plain dev instance's profiles, other
// devices whose userData nests in its own. A marker that can't be read
// deletes nothing and stays: half a nuke (userData gone, the data dir
// kept) would be no install at all. So does one with something left,
// for the next start to finish, after deleting all it could.
export function finishPendingNuke(userData: string): {
  readonly left: readonly { readonly path: string; readonly why: string }[];
} | null {
  const marker = join(userData, NUKE_MARKER);
  if (!existsSync(marker)) return null;
  const decoded = decodeMarker(readFileSync(marker, "utf8"));
  if (Option.isNone(decoded)) {
    console.warn(`[nuke] ${marker} can't be read, so nothing was deleted`);
    return null;
  }
  const left: { path: string; why: string }[] = [];
  for (const path of decoded.value.paths) remove(path, left);
  for (const entry of readdirSync(userData)) {
    if (
      entry === NUKE_MARKER ||
      entry === DEV_PROFILES_DIR ||
      entry.startsWith("Singleton")
    ) {
      continue;
    }
    remove(join(userData, entry), left);
  }
  if (left.length === 0) rmSync(marker, { force: true });
  return { left };
}
