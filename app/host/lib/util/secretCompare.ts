// Constant-time comparison of two bearer secrets, for the node-side
// listeners (the LAN socket's token, the mirror gateway's). Hashing
// first makes the compare fixed width, so neither the length nor a
// shared prefix is measurable. An empty secret on either side never
// matches, so a listener whose secret was never set fails closed.
import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function secretsMatch(given: string, expected: string): boolean {
  if (given === "" || expected === "") return false;
  return timingSafeEqual(digest(given), digest(expected));
}
