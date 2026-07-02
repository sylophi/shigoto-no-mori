// Tiny JSON-file persistence in the shigomori root. Atomic via tmp+rename.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// Same tmp-name discipline as util/jsonFile.ts. Sync writes can't
// interleave within this process, but a fixed `.tmp` suffix would let a
// second app instance race the same tmp file, so the name carries
// pid + time + counter.
let tempCounter = 0;

function writeAll(data: Record<string, unknown>): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${tempCounter++}`;
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
