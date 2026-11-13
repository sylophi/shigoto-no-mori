// Compiles one of the Go helpers into a standalone binary in its dist
// dir (shared/packaging/goHelpersDist.mts): the file-sync engine (the
// Go module in file-sync/, the continuous worktree mirror built on
// Mutagen, which only the host spawns, host/fileSync/runner.ts) or the
// filesystem helper (nativefs/, the filesystem calls Node has no
// binding for). Built by `pnpm dev` beside the dev CLI and by the
// prePackage hook for a release.
//
// Run: pnpm file-sync:build, pnpm nativefs:build
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
  NATIVEFS_BINARY_NAME,
  NATIVEFS_DIST_DIR,
} from "../shared/packaging/goHelpersDist.mts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

const HELPERS = {
  "file-sync": {
    outfile: join(FILE_SYNC_DIST_DIR, FILE_SYNC_BINARY_NAME),
    // Mutagen's macOS file watcher (its fsevents cgo binding) calls an
    // FSEvents API Apple deprecated in macOS 13. It still works, and
    // the warning is theirs to fix, so keep the build output clean.
    env: { CGO_CFLAGS: "-Wno-deprecated-declarations" },
  },
  nativefs: {
    outfile: join(NATIVEFS_DIST_DIR, NATIVEFS_BINARY_NAME),
    env: {},
  },
};

const name = process.argv[2];
if (name !== "file-sync" && name !== "nativefs") {
  throw new Error("Usage: build-go.mts <file-sync|nativefs>");
}
const helper = HELPERS[name];
const exe = process.platform === "win32" ? ".exe" : "";
const outfile = join(appRoot, helper.outfile + exe);

execFileSync(
  "go",
  [
    "build",
    "-C",
    join(repoRoot, name),
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    outfile,
    ".",
  ],
  { cwd: appRoot, stdio: "inherit", env: { ...process.env, ...helper.env } },
);
console.log(`built ${outfile}`);
