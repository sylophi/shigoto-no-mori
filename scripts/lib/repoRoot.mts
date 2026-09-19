// Repo root, resolved from this file's location under scripts/lib/.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
