// package.json's scripts in manifest order: only string-valued entries
// count, a duplicated name is listed twice, and a missing or non-object
// scripts block means none. JSON.parse would put integer-like names
// first and keep one of each duplicate, so after it vouches for the
// text, the members are walked in order.
import { members } from "./json.ts";

type PackageScript = { readonly name: string; readonly command: string };

// Throws on text that isn't JSON or isn't an object (null reads as no
// scripts).
export function packageScripts(text: string): ReadonlyArray<PackageScript> {
  const top: unknown = JSON.parse(text);
  if (top === null) return [];
  if (typeof top !== "object" || Array.isArray(top)) {
    throw new Error("package.json is not a JSON object");
  }
  const scripts = members(text.trim()).findLast(
    ([name]) => name === "scripts",
  )?.[1];
  if (scripts === undefined || !scripts.startsWith("{")) return [];
  return members(scripts).flatMap(([name, value]) => {
    const command: unknown = JSON.parse(value);
    return typeof command === "string" ? [{ name, command }] : [];
  });
}
