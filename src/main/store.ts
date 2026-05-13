// Tiny JSON-file persistence in ~/shigomori. Atomic via tmp+rename.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const FILE = "state.json";

function filePath(): string {
  return join(homedir(), "shigomori", FILE);
}

function readAll(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filePath(), "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function writeAll(data: Record<string, unknown>): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

export function readKey<T>(key: string, fallback: T): T {
  const all = readAll();
  if (key in all) return all[key] as T;
  return fallback;
}

export function writeKey<T>(key: string, value: T): void {
  const all = readAll();
  all[key] = value;
  writeAll(all);
}
