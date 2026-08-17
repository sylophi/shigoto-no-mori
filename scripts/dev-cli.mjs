// Runs before `pnpm dev`: compiles the dev-flavor CLI into dist-cli/
// so the app can delegate to it. Installing the `smd` PATH link is
// NOT done here; the app prompts for that on launch, same as the
// packaged app does for `sm` (main/electron/cliInstall.ts). Fail-soft: a
// missing Go toolchain warns and lets the app start anyway (it falls
// back to the TS engine).
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  execFileSync("node", [join(repoRoot, "scripts", "build-cli.mjs"), "--dev"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch (err) {
  console.warn(
    `[dev-cli] skipped (${err instanceof Error ? err.message : err})`,
  );
}
