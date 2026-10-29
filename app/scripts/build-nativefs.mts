// Compiles the filesystem helper (a Go module in nativefs/, the filesystem
// calls Node has no binding for) into a standalone binary at
// dist-nativefs/nativefs. Built by `pnpm dev` beside the dev CLI and by the
// prePackage hook for a release.
//
// Run: pnpm nativefs:build
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  NATIVEFS_BINARY_NAME,
  NATIVEFS_DIST_DIR,
} from "../shared/packaging/nativefsDist.mts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

const outfile = join(appRoot, NATIVEFS_DIST_DIR, NATIVEFS_BINARY_NAME);

execFileSync(
  "go",
  [
    "build",
    "-C",
    join(repoRoot, "nativefs"),
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    outfile,
    ".",
  ],
  { cwd: appRoot, stdio: "inherit" },
);
console.log(`built ${outfile}`);
