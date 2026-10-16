// The start after a nuke (main/electron/nuke.ts writes the marker): the
// pure half, electron-free so a proof drives it under plain node
// (test/nuke.mts). It deletes what the marker names and everything in
// userData, the marker last, so a start that dies halfway through finds
// the marker and deletes the rest.
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DEV_PROFILES_DIR } from "@shared/packaging/appName.mts";

export const NUKE_MARKER = "nuke.pending";

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

// Whether a marker was found. The lock's own files stay, since this
// process holds the lock through them, and so do the plain dev
// instance's profiles, other devices whose userData nests in its own.
// A marker that can't be read deletes nothing and stays: half a nuke
// (userData gone, the data dir kept) would be no install at all.
export function finishPendingNuke(userData: string): boolean {
  const marker = join(userData, NUKE_MARKER);
  if (!existsSync(marker)) return false;
  const decoded = decodeMarker(readFileSync(marker, "utf8"));
  if (Option.isNone(decoded)) {
    console.warn(`[nuke] ${marker} can't be read; nothing deleted`);
    return false;
  }
  for (const path of decoded.value.paths)
    rmSync(path, { recursive: true, force: true });
  for (const entry of readdirSync(userData)) {
    if (
      entry === NUKE_MARKER ||
      entry === DEV_PROFILES_DIR ||
      entry.startsWith("Singleton")
    ) {
      continue;
    }
    rmSync(join(userData, entry), { recursive: true, force: true });
  }
  rmSync(marker, { force: true });
  return true;
}
