// Constant-time comparison of two secrets that arrived as text, shared
// by every node-side listener that authenticates a bearer string (the
// LAN socket's static token, the mirror gateway's per-bind token).
//
// Hashing first is what makes the compare fixed width: timingSafeEqual
// throws on a length mismatch, and the lengths themselves would
// otherwise be measurable. An empty secret on either side never
// matches, so a listener whose secret was never set fails closed
// instead of admitting everyone.
//
// Browser-side code cannot use this (node:crypto): the direct plane's
// handshake carries its own compare in shared/ipc/socket/proof.ts.
import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function secretsMatch(given: string, expected: string): boolean {
  if (given === "" || expected === "") return false;
  return timingSafeEqual(digest(given), digest(expected));
}
