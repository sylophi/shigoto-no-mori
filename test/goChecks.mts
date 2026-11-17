// `pnpm check:go`: each Go module vetted whole and its tests run, in a
// test run's temp folder (testTemp.mts), up to the first that fails.
import { spawnSync } from "node:child_process";
import { isolateGit } from "./gitIsolation.ts";
import { ownTestTemp } from "./testTemp.mts";

ownTestTemp("go");
isolateGit();
for (const module of ["file-sync", "nativefs", "cli-launcher"]) {
  const { status, error } = spawnSync(
    "go",
    ["test", "-C", module, "-vet=all", "./..."],
    {
      stdio: "inherit",
      // Mutagen's macOS watcher's deprecation warnings (app/scripts/build-go.mts).
      env: { ...process.env, CGO_CFLAGS: "-Wno-deprecated-declarations" },
    },
  );
  if (error !== undefined) throw error;
  if (status !== 0) {
    process.exitCode = status ?? 1;
    break;
  }
}
