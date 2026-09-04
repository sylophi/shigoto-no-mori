// Runs before `pnpm dev`: compiles the dev-flavor CLI into dist-cli/
// and the file-sync engine into dist-file-sync/ so the app can
// delegate to them. Installing the `smd` PATH link is
// NOT done here; the app prompts for that on launch, same as the
// packaged app does for `sm` (main/electron/cliInstall.ts). The CLI is
// the app's only engine, so a failed build (missing Go toolchain)
// aborts the dev run. The two Go builds are independent and run side
// by side.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function build(script, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(repoRoot, "scripts", script), ...args], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${code}`));
    });
  });
}

// The file-sync engine ships beside the CLI and the app spawns it the
// same way, so a dev run builds it here too (one flavor, see
// shared/fileSyncDist.mts).
await Promise.all([
  build("build-cli.mjs", "--dev"),
  build("build-file-sync.mjs"),
]);
