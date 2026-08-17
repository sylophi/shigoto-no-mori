// Runs before `pnpm dev`: compiles the dev-flavor CLI into dist-cli/
// so the app can delegate to it. Installing the `smd` PATH link is
// NOT done here; the app prompts for that on launch, same as the
// packaged app does for `sm` (main/electron/cliInstall.ts). The CLI is
// the app's only engine, so a failed build (missing Go toolchain)
// aborts the dev run.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

execFileSync("node", [join(repoRoot, "scripts", "build-cli.mjs"), "--dev"], {
  cwd: repoRoot,
  stdio: "inherit",
});
