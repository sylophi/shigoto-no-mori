// Root directory for shigomori on-disk state. Split between packaged and dev
// builds so a `pnpm run dev` session can't trample a real ~/shigomori/.
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isWindows } from "./platform";

let cachedRoot: string | null = null;

// Called once at boot from main/index.ts with `app.isPackaged`. Keeping the
// `electron` import out of this file is what lets the rest of `main/lib/`
// stay free of Electron coupling. Refuses a second call so a stray re-init
// from somewhere unexpected fails loudly instead of silently flipping the
// path under live callers.
export function initShigomoriRoot(isPackaged: boolean): void {
  if (cachedRoot !== null) {
    throw new Error("shigomoriRoot already initialized");
  }
  cachedRoot = join(homedir(), isPackaged ? "shigomori" : "shigomori-dev");
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

// Comparison form for path equality and prefix checks. Git for Windows
// reports paths with forward slashes ("C:/Users/…") while node's join
// builds backslashes, and NTFS paths are case-insensitive, so both
// sides fold separators and case before comparing. Identity on POSIX,
// where backslash is a legal filename character and case matters.
export function comparablePath(path: string): string {
  if (!isWindows) return path;
  return path.replaceAll("\\", "/").toLowerCase();
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
