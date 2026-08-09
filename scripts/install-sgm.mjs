// Builds the prod-flavor CLI and symlinks it into the user's bin dir --
// the repo-checkout equivalent of the app's launch-time install (which
// links the binary bundled in its Resources). The link points at
// dist-cli/sgm in this checkout, so rebuilding refreshes the installed
// command in place.
//
// Run: pnpm cli:install
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

if (process.platform === "win32") {
  console.error("The sgm CLI isn't supported on Windows.");
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const name = sgmBinaryName("prod");
const binary = join(repoRoot, SGM_DIST_DIR, name);
const link = join(sgmUserBinDir(), name);

execFileSync("node", [join(repoRoot, "scripts", "build-sgm.mjs")], {
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
  console.error(`${link} exists and isn't a symlink; refusing to replace it.`);
  process.exit(1);
}
const previous = existing ? readlinkSync(link) : null;
if (previous === binary) {
  console.log(`${link} already points at this checkout's build.`);
} else {
  replaceWithSymlinkSync(binary, link);
  console.log(`linked ${link} -> ${binary}`);
  if (previous !== null && previous !== binary) {
    console.log(`(replaced previous link to ${previous})`);
  }
}

const binDir = sgmUserBinDir();
const onPath = (process.env.PATH ?? "").split(":").includes(binDir);
if (!onPath) {
  console.warn(
    `note: ${binDir} isn't on your PATH; add it to your shell profile to use ${name}.`,
  );
}
