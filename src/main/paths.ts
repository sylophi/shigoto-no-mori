// Root directory for shigomori on-disk state. Split between packaged and dev
// builds so a `pnpm run dev` session can't trample a real ~/shigomori/.
import { homedir } from "node:os";
import { join } from "node:path";
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
