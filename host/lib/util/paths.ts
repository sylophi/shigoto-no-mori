// The data dir: where shigomori keeps its on-disk state. Split between
// packaged and dev builds so a `pnpm run dev` session can't trample a
// real ~/.sm/.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type CliFlavor,
  cliDataDirName,
  dataDirPointerPath as pointerPathFor,
  legacyDataDirName,
  legacyDataDirPointerPath as legacyPointerPathFor,
} from "@shared/cliDist.mts";

// How the data dir was resolved: the env override, a pointer file
// (either filename), a pre-2.0 default adopted in place, or the flavor
// default. Reported to the renderer and mirrored by the CLI's doctor.
export type DataDirSource = "env" | "pointer" | "legacy" | "default";

// The top-level files a used data dir holds. Bootstrap seeds the last
// two, and the registry appears on the first registry write. Their
// presence is what tells a data dir apart from an unrelated folder.
export const REGISTRY_FILE = "registry.json";
export const STATE_FILE = "state.json";
export const CONFIG_FILE = "config.json";
const STATE_FILES = [REGISTRY_FILE, STATE_FILE, CONFIG_FILE];

let cachedDataDir: string | null = null;
let cachedSource: DataDirSource = "env";
// The flavor initDataDir booted with. Null under initDataDirAt (tests,
// the check scripts), where there is no pointer to write and no
// canonical name to rename to.
let cachedFlavor: CliFlavor | null = null;
// The pointer file the resolution actually read, for messages.
let cachedPointerRead: string | null = null;

// Called once at boot from main/index.ts with `app.isPackaged`. Keeping the
// `electron` import out of this file is what lets the rest of `host/lib/`
// stay free of Electron coupling. Refuses a second call so a stray re-init
// from somewhere unexpected fails loudly instead of silently flipping the
// path under live callers. Resolution matches the CLI (cli/state.go
// initDataDir): SHIGOMORI_DATA_DIR env override first (so a test harness
// can sandbox the app), then the flavor's pointer file (policy in
// shared/cliDist.mts), then the flavor's default under $HOME, with a
// pre-2.0 default adopted in place while it still holds the state.
//
// The override is something a human or a test harness sets, and it must
// stay that way: the app itself may never put SHIGOMORI_DATA_DIR into a
// child's environment. Env vars are inherited by the whole process
// tree, and the app runs the user's package.json scripts -- so a `dev`
// script launched from the packaged app's script runner would boot the
// dev build, see the packaged app's data dir here, and quietly operate
// on real data. A sandboxed session needs no injection either: children
// inherit the var from the app's own environment already.
export function initDataDir(isPackaged: boolean): void {
  const flavor: CliFlavor = isPackaged ? "prod" : "dev";
  const envDir = process.env.SHIGOMORI_DATA_DIR;
  if (envDir) {
    initDataDirAt(toAbsolute(envDir), "env");
    cachedFlavor = flavor;
    return;
  }
  // The override's pre-2.0 name. Its whole point was sandboxing, so a
  // leftover export must not fail open onto the real data dir.
  if (process.env.SHIGOMORI_ROOT) {
    throw new Error(
      "SHIGOMORI_ROOT is no longer read. Set SHIGOMORI_DATA_DIR instead.",
    );
  }
  // The pre-2.0 pointer filename is consulted only when the current
  // one is absent, so a stale old pointer can't outrank an unusable
  // current one.
  for (const pointerPath of [
    pointerPathFor(flavor),
    legacyPointerPathFor(flavor),
  ]) {
    const raw = readPointerRaw(pointerPath);
    if (raw === null) continue;
    const pointed = pointerTarget(raw);
    if (pointed !== null) {
      initDataDirAt(pointed, "pointer");
      cachedFlavor = flavor;
      cachedPointerRead = pointerPath;
      return;
    }
    break;
  }
  const home = homedir();
  const current = join(home, cliDataDirName(flavor));
  const legacy = join(home, legacyDataDirName(flavor));
  // A pre-2.0 dir that still holds state is adopted where it stands
  // while the current name holds none, so an upgrade never boots into
  // an empty data dir beside a full one. A legacy dir that exists but
  // can't be read counts as holding state: adopting it makes boot fail
  // loudly on it, where seeding the current name would orphan the
  // data for good. The move flow (dataDirMove.ts) is what renames it.
  // Mirrored by the CLI (cli/state.go initDataDir) -- keep in sync.
  const adoptLegacy =
    holdsState(legacy) !== false && holdsState(current) !== true;
  initDataDirAt(
    adoptLegacy ? legacy : current,
    adoptLegacy ? "legacy" : "default",
  );
  cachedFlavor = flavor;
}

export function dataDirSource(): DataDirSource {
  dataDir();
  return cachedSource;
}

// The pointer file that redirected this boot, or null when none did.
export function dataDirPointerRead(): string | null {
  dataDir();
  return cachedPointerRead;
}

// The flavor's pointer-file locations, for the writer (the data dir
// move). Only meaningful when the data dir came from the normal boot
// resolution -- under a SHIGOMORI_DATA_DIR override or an initDataDirAt
// entry point (tests) there is no pointer to write, and moving the
// data dir would edit state the sandbox doesn't own.
export function dataDirPointerPath(): string {
  return pointerPathFor(movableFlavor());
}

export function legacyDataDirPointerPath(): string {
  return legacyPointerPathFor(movableFlavor());
}

// The flavor's folder name (".sm" / ".smd"): what a move renames the
// folder to, and what the renderer shows as the canonical name.
export function canonicalDataDirName(): string {
  if (cachedFlavor === null) {
    throw new Error(
      "canonicalDataDirName needs initDataDir, not initDataDirAt",
    );
  }
  return cliDataDirName(cachedFlavor);
}

// The flavor's default location, which needs no pointer file.
export function defaultDataDir(): string {
  return join(homedir(), canonicalDataDirName());
}

function movableFlavor(): CliFlavor {
  if (cachedFlavor === null || cachedSource === "env") {
    throw new Error(
      "The data folder can't be moved in this session: the data dir " +
        "was overridden (SHIGOMORI_DATA_DIR) or set without a flavor.",
    );
  }
  return cachedFlavor;
}

// The pointer file's content, or null when it can't be read. Sync on
// purpose: this runs once, at module-top-level boot, before the config
// stores exist.
function readPointerRaw(pointerPath: string): string | null {
  try {
    return readFileSync(pointerPath, "utf8");
  } catch {
    return null;
  }
}

// Empty or non-absolute content falls through (null) -- boot must not
// die on a malformed hand-edited file.
function pointerTarget(raw: string): string | null {
  const target = expandHome(raw.trim());
  if (target === "" || !isAbsolute(target)) return null;
  return looksLikeDataDir(target) ? target : null;
}

// Guard on what a hand-edited pointer may aim the data dir at: a
// directory that doesn't exist yet, is empty, or already holds
// shigomori state. The data dir is the target of destructive
// operations (nuke rm -rf's it), so a pointer at ~/Documents must fall
// back to the default rather than adopt a directory full of unrelated
// files. Mirrored by the CLI (cli/state.go looksLikeDataDir) -- keep
// the two in sync.
function looksLikeDataDir(target: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch (err) {
    // Nonexistent is fine (bootstrap creates it). A file or an
    // unreadable path is not a usable data dir.
    return isENOENT(err);
  }
  return entries.length === 0 || entries.some((e) => STATE_FILES.includes(e));
}

// Whether a directory has been used as a data dir: true when one of
// the state files is there, false when none is (or the directory is
// missing or not a directory), null when it exists but can't be read.
// Stats the three files rather than listing the directory.
function holdsState(dir: string): boolean | null {
  let unreadable = false;
  for (const file of STATE_FILES) {
    try {
      statSync(join(dir, file));
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") unreadable = true;
    }
  }
  return unreadable ? null : false;
}

// Explicit-path variant for non-Electron entry points (the CLI, tests)
// where the data dir comes from a flag or env var instead of
// app.isPackaged. Same one-shot guard.
export function initDataDirAt(
  dir: string,
  source: DataDirSource = "env",
): void {
  if (cachedDataDir !== null) {
    throw new Error("dataDir already initialized");
  }
  cachedDataDir = dir;
  cachedSource = source;
}

export function dataDir(): string {
  if (cachedDataDir === null) {
    throw new Error("dataDir not initialized; call initDataDir at boot");
  }
  return cachedDataDir;
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function toAbsolute(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
