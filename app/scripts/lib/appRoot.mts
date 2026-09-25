// The app root (app/ in the repo), resolved from this file's location
// under scripts/lib/.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const appRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

// The repo (and worktree) root, one level up: where cli/ and
// file-sync/ live.
export const repoRoot = dirname(appRoot);
