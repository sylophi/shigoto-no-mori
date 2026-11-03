// The minimal key-value seam every web-side store is written against.
// It is the subset of the DOM Storage interface the stores actually
// use, so window.localStorage and window.sessionStorage satisfy it
// directly. Everything in web/ that persists reads storage through an
// injected KeyValueStorage rather than touching a browser global at
// module scope.
import type { ContractSchema } from "@shigomori/contracts/contract";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

// Guarded read: DOM storage can throw outright (privacy modes, quota,
// disabled third-party storage), and no web-side store is worth taking
// the page down for. Mirrors renderer/lib/localStorage.ts.
export function readKey(storage: KeyValueStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

// A stored JSON document read against its schema. Absent, unparseable
// and wrong-shaped all read as `fallback`: corrupt storage reads as
// defaults, and the next write heals it.
export function readJsonKey<S extends ContractSchema>(
  storage: KeyValueStorage,
  key: string,
  schema: S,
  fallback: S["Type"],
): S["Type"] {
  const raw = readKey(storage, key);
  if (raw === null) return fallback;
  return Result.getOrElse(
    Schema.decodeResult(Schema.fromJsonString(schema))(raw),
    () => fallback,
  );
}

export function writeKey(
  storage: KeyValueStorage,
  key: string,
  value: string,
): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Unavailable storage costs persistence across reloads, nothing more.
  }
}
