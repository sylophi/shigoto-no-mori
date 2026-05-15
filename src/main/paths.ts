// Root directory for shigomori on-disk state. Split between packaged and dev
// builds so a `pnpm run dev` session can't trample a real ~/shigomori/.
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { app } from "electron";

export function shigomoriRoot(): string {
  const name = app.isPackaged ? "shigomori" : "shigomori-dev";
  return join(homedir(), name);
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
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
