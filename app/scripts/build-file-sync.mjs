// Compiles the file-sync engine (a Go module in file-sync/, the
// continuous worktree mirror built on Mutagen) into a standalone
// binary at dist-file-sync/file-sync. Built by `pnpm dev` beside the
// dev CLI and by the prePackage hook for a release. The app's main
// process spawns it (main/electron/fileSyncRunner.ts) and nothing else
// ever runs it.
//
// Run: pnpm file-sync:build
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "../shared/packaging/fileSyncDist.mts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

const outfile = join(appRoot, FILE_SYNC_DIST_DIR, FILE_SYNC_BINARY_NAME);

execFileSync(
  "go",
  [
    "build",
    "-C",
    join(repoRoot, "file-sync"),
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    outfile,
    ".",
  ],
  {
    cwd: appRoot,
    stdio: "inherit",
    // Mutagen's macOS file watcher (its fsevents cgo binding) calls an
    // FSEvents API Apple deprecated in macOS 13. It still works, and
    // the warning is theirs to fix, so keep the build output clean.
    env: { ...process.env, CGO_CFLAGS: "-Wno-deprecated-declarations" },
  },
);
console.log(`built ${outfile}`);
