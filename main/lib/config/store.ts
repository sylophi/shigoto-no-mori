// Tiny JSON-file persistence in the shigomori root. Atomic via tmp+rename.
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tempPathFor } from "../util/jsonFile";
import { shigomoriRoot } from "../util/paths";

const FILE = "state.json";

function filePath(): string {
  return join(shigomoriRoot(), FILE);
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
  const tmp = tempPathFor(path);
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort; the stray tmp file is harmless.
    }
    throw error;
  }
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
