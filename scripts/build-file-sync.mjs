// Compiles the file-sync engine (a Go module in file-sync/, the
// continuous worktree mirror built on Mutagen) into a standalone
// binary at dist-file-sync/file-sync. Built by `pnpm dev` beside the
// dev CLI and by the prePackage hook for a release; the app's main
// process spawns it (main/electron/fileSyncRunner.ts) and nothing else
// ever runs it.
//
// Run: pnpm file-sync:build
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "../shared/fileSyncDist.mts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(repoRoot, FILE_SYNC_DIST_DIR, FILE_SYNC_BINARY_NAME);

execFileSync(
  "go",
  [
    "build",
    "-C",
    "file-sync",
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    outfile,
    ".",
  ],
  {
    cwd: repoRoot,
    stdio: "inherit",
    // Mutagen's macOS file watcher (its fsevents cgo binding) calls an
    // FSEvents API Apple deprecated in macOS 13. It still works, and
    // the warning is theirs to fix, so keep the build output clean.
    env: { ...process.env, CGO_CFLAGS: "-Wno-deprecated-declarations" },
  },
);
console.log(`built ${outfile}`);
