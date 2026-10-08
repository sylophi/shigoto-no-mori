// Compiles the darwin helper (a Go module in macfs/, the filesystem
// calls Node has no binding for) into a standalone binary at
// dist-macfs/macfs. Built by `pnpm dev` beside the dev CLI and by the
// prePackage hook for a release.
//
// Run: pnpm macfs:build
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  MACFS_BINARY_NAME,
  MACFS_DIST_DIR,
} from "../shared/packaging/macfsDist.mts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

const outfile = join(appRoot, MACFS_DIST_DIR, MACFS_BINARY_NAME);

execFileSync(
  "go",
  [
    "build",
    "-C",
    join(repoRoot, "macfs"),
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
