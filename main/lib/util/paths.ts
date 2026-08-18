// Root directory for shigomori on-disk state. Split between packaged and dev
// builds so a `pnpm run dev` session can't trample a real ~/shigomori/.
import { readdirSync, readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  cliRootDirName,
  rootPointerPath as pointerPathFor,
} from "@shared/cliDist.mts";

let cachedRoot: string | null = null;
let cachedPointerPath: string | null = null;

// Called once at boot from main/index.ts with `app.isPackaged`. Keeping the
// `electron` import out of this file is what lets the rest of `main/lib/`
// stay free of Electron coupling. Refuses a second call so a stray re-init
// from somewhere unexpected fails loudly instead of silently flipping the
// path under live callers. Resolution matches the CLI (cli/state.go):
// SHIGOMORI_ROOT env override first (so a test harness can sandbox the
// app), then the flavor's pointer file (policy in shared/cliDist.mts),
// then ~/<rootDirName>.
//
// The override is something a human or a test harness sets, and it must
// stay that way: the app itself may never put SHIGOMORI_ROOT into a
// child's environment. Env vars are inherited by the whole process
// tree, and the app runs the user's package.json scripts -- so a `dev`
// script launched from the packaged app's script runner would boot the
// dev build, see the packaged app's root here, and quietly operate on
// real data. A sandboxed session needs no injection either: children
// inherit the var from the app's own environment already.
export function initShigomoriRoot(isPackaged: boolean): void {
  const envRoot = process.env.SHIGOMORI_ROOT;
  if (envRoot) {
    // cachedPointerPath stays null: a sandboxed session must not write
    // the real pointer file (rootPointerPath() below refuses).
    initShigomoriRootAt(toAbsolute(envRoot));
    return;
  }
  const flavor = isPackaged ? "prod" : "dev";
  const pointerPath = pointerPathFor(flavor);
  initShigomoriRootAt(
    readRootPointer(pointerPath) ?? join(homedir(), cliRootDirName(flavor)),
  );
  cachedPointerPath = pointerPath;
}

// The live flavor's pointer-file location, for writers (the root move).
// Only meaningful when the root came from the normal boot resolution --
// under a SHIGOMORI_ROOT override or an initShigomoriRootAt entry point
// (tests) there is no pointer to write, and moving the root would edit
// state the sandbox doesn't own.
export function rootPointerPath(): string {
  if (cachedPointerPath === null) {
    throw new Error(
      "The data folder can't be moved in this session: the root was " +
        "overridden (SHIGOMORI_ROOT) or set without a flavor.",
    );
  }
  return cachedPointerPath;
}

// Missing, empty, or non-absolute content falls through to the default
// (null) -- boot must not die on a malformed hand-edited file. Sync on
// purpose: this runs once, at module-top-level boot, before the config
// stores exist.
function readRootPointer(pointerPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(pointerPath, "utf8");
  } catch {
    return null;
  }
  const target = expandHome(raw.trim());
  if (target === "" || !isAbsolute(target)) return null;
  return looksLikeRootTarget(target) ? target : null;
}

// Guard on what a hand-edited pointer may aim the root at: a directory
// that doesn't exist yet, is empty, or already holds shigomori state.
// The root is the target of destructive operations (nuke rm -rf's it),
// so a pointer at ~/Documents must fall back to the default rather
// than adopt a directory full of unrelated files. Mirrored by the CLI
// (cli/state.go looksLikeRootTarget) -- keep the two in sync.
function looksLikeRootTarget(target: string): boolean {
  let entries: string[];
  try {
    entries = readdirSync(target);
  } catch (err) {
    // Nonexistent is fine (bootstrap creates it). A file or an
    // unreadable path is not a usable root.
    return isENOENT(err);
  }
  return (
    entries.length === 0 ||
    entries.includes("registry.json") ||
    entries.includes("state.json") ||
    entries.includes("config.json")
  );
}

// Explicit-path variant for non-Electron entry points (the CLI, tests)
// where the root comes from a flag or env var instead of app.isPackaged.
// Same one-shot guard.
export function initShigomoriRootAt(root: string): void {
  if (cachedRoot !== null) {
    throw new Error("shigomoriRoot already initialized");
  }
  cachedRoot = root;
}

export function shigomoriRoot(): string {
  if (cachedRoot === null) {
    throw new Error(
      "shigomoriRoot not initialized; call initShigomoriRoot at boot",
    );
  }
  return cachedRoot;
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
