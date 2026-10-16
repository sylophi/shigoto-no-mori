// After the last walk: the lab build's footprint off the machine (its
// settings, logs and keychain item; footprint.ts), the bundle kept.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labCli, refuseRunningLab } from "./labApp.mts";

export function teardown(): void {
  // Someone's own lab build, which the walks refused to touch.
  refuseRunningLab();
  const dataDir = mkdtempSync(join(tmpdir(), "sm-walk-nuke-"));
  try {
    execFileSync(labCli(), ["nuke", "--yes", "--keep-app"], {
      env: { ...process.env, SHIGOMORI_DATA_DIR: dataDir },
      stdio: "ignore",
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
