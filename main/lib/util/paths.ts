// Root directory for shigomori on-disk state. Split between packaged and dev
// builds so a `pnpm run dev` session can't trample a real ~/shigomori/.
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { cliRootDirName } from "@shared/cliDist.mts";
import { isWindows } from "./platform";

let cachedRoot: string | null = null;

// Called once at boot from main/index.ts with `app.isPackaged`. Keeping the
// `electron` import out of this file is what lets the rest of `main/lib/`
// stay free of Electron coupling. Refuses a second call so a stray re-init
// from somewhere unexpected fails loudly instead of silently flipping the
// path under live callers.
export function initShigomoriRoot(isPackaged: boolean): void {
  initShigomoriRootAt(
    join(homedir(), cliRootDirName(isPackaged ? "prod" : "dev")),
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
  // On Windows both separator styles work after "~"; on POSIX a
  // backslash is an ordinary filename character, not a separator.
  if (path.startsWith("~/") || (isWindows && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

// Comparison form for path equality and prefix checks; the
// implementation lives in shared/worktreeLayout.ts (shape-keyed, so the
// renderer folds identically) and is re-exported here for main-side
// callers.
export { comparablePath } from "@shared/worktreeLayout";

export function toAbsolute(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

// Fold to the OS-native separator before handing a path to anything
// outside the app. Git porcelain reports forward slashes even on
// Windows; explorer.exe rejects those outright and other shell targets
// merely tolerate them. No-op on POSIX, where backslash is a filename
// character.
export function toNativePath(path: string): string {
  return isWindows ? path.replaceAll("/", "\\") : path;
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
