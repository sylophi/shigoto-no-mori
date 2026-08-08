// Runs before `pnpm dev`: compiles the dev-flavor CLI and symlinks it
// into the user's bin dir as `sgm-d` -- the dev counterpart of the
// app's launch-time prod-sgm install (naming and path policy in
// shared/sgmDist.mts). Fail-soft: a missing bun or an unwritable bin
// dir warns and lets the app start anyway.
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SGM_DIST_DIR,
  replaceWithSymlinkSync,
  sgmBinaryName,
  sgmUserBinDir,
} from "../shared/sgmDist.mts";

if (process.platform === "win32") process.exit(0);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = sgmBinaryName("dev");
const binary = join(repoRoot, SGM_DIST_DIR, name);
const link = join(sgmUserBinDir(), name);

try {
  execFileSync("node", [join(repoRoot, "scripts", "build-sgm.mjs"), "--dev"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  const existing = (() => {
    try {
      return lstatSync(link);
    } catch {
      return null;
    }
  })();
  if (existing && !existing.isSymbolicLink()) {
    console.warn(`[dev-sgm] ${link} exists and isn't a symlink; leaving it`);
    process.exit(0);
  }
  if (existing && readlinkSync(link) === binary) process.exit(0);

  replaceWithSymlinkSync(binary, link);
  console.log(`[dev-sgm] linked ${link} -> ${binary}`);
} catch (err) {
  console.warn(
    `[dev-sgm] skipped (${err instanceof Error ? err.message : err})`,
  );
}
