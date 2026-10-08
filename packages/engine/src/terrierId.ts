// A terrier project's id: UUID-shaped from sha256 of its path,
// uppercased like every CLI-minted id. Fixed for good: a project's
// settings and the app's caches are keyed by it.
import { createHash } from "node:crypto";

export function terrierProjectId(path: string): string {
  const hex = createHash("sha256")
    .update(path)
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
