// Runs one of the scripts in scripts/ to completion, from the app root,
// as the build steps chain them. A failed script throws.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { appRoot } from "./appRoot.mts";

export function runScript(script: string, ...args: string[]): void {
  execFileSync("node", [join(appRoot, "scripts", script), ...args], {
    cwd: appRoot,
    stdio: "inherit",
  });
}
