// Builds the prod-flavor CLI and symlinks it into the user's bin dir,
// the repo-checkout equivalent of the app's Settings install (which
// links the binary bundled in its Resources). Both command names (sm
// and shigomori) point at dist-cli/sm in this checkout, so rebuilding
// refreshes the installed commands in place.
//
// Run: pnpm cli:install
import { execFileSync } from "node:child_process";
import { lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import {
  CLI_DIST_DIR,
  replaceWithSymlinkSync,
  cliAliasName,
  cliBinaryName,
  cliUserBinDir,
} from "../shared/packaging/cliDist.mts";
import { appRoot } from "./lib/appRoot.mts";

const binary = join(appRoot, CLI_DIST_DIR, cliBinaryName("prod"));

execFileSync("node", [join(appRoot, "scripts", "build-cli.mjs")], {
  cwd: appRoot,
  stdio: "inherit",
});

for (const name of [cliBinaryName("prod"), cliAliasName("prod")]) {
  const link = join(cliUserBinDir(), name);
  const existing = (() => {
    try {
      return lstatSync(link);
    } catch {
      return null;
    }
  })();
  if (existing && !existing.isSymbolicLink()) {
    console.error(
      `${link} exists and isn't a symlink; refusing to replace it.`,
    );
    continue;
  }
  const previous = existing ? readlinkSync(link) : null;
  if (previous === binary) {
    console.log(`${link} already points at this checkout's build.`);
    continue;
  }
  replaceWithSymlinkSync(binary, link);
  console.log(`linked ${link} -> ${binary}`);
  if (previous !== null) {
    console.log(`(replaced previous link to ${previous})`);
  }
}

const binDir = cliUserBinDir();
const onPath = (process.env.PATH ?? "").split(":").includes(binDir);
if (!onPath) {
  console.warn(
    `note: ${binDir} isn't on your PATH; add it to your shell profile.`,
  );
}
