// Compiles one of the Go helpers into a standalone binary in its dist
// dir (shared/packaging/goHelpersDist.mts): the file-sync engine (the
// Go module in file-sync/, the continuous worktree mirror built on
// Mutagen, which only the host spawns, host/fileSync/runner.ts), the
// filesystem helper (nativefs/, the filesystem calls Node has no
// binding for) or the Windows launcher of the terminal command
// (cli-launcher/, for the packaged build's flavor, SM_FLAVOR). The
// engine and the helper are built by `pnpm dev` beside the dev CLI, and
// the prePackage hook builds what a release ships.
//
// Run: pnpm file-sync:build, pnpm nativefs:build, pnpm cli-launcher:build
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { buildFlavor } from "../shared/packaging/buildFlavor.mts";
import { cliBinaryName } from "../shared/packaging/cliDist.mts";
import {
  CLI_LAUNCHER_BINARY_NAME,
  CLI_LAUNCHER_DIST_DIR,
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
  NATIVEFS_BINARY_NAME,
  NATIVEFS_DIST_DIR,
} from "../shared/packaging/goHelpersDist.mts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

type Helper = {
  readonly outfile: string;
  readonly env: Record<string, string>;
  readonly ldflags?: () => string;
};

const HELPERS: Record<string, Helper> = {
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
  "cli-launcher": {
    outfile: join(CLI_LAUNCHER_DIST_DIR, CLI_LAUNCHER_BINARY_NAME),
    env: {},
    ldflags: () => `-X main.program=${cliBinaryName(buildFlavor(process.env))}`,
  },
};

const name = process.argv[2] ?? "";
const helper = HELPERS[name];
if (helper === undefined) {
  throw new Error(`Usage: build-go.mts <${Object.keys(HELPERS).join("|")}>`);
}
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
    ["-s -w", helper.ldflags?.()].filter(Boolean).join(" "),
    "-o",
    outfile,
    ".",
  ],
  { cwd: appRoot, stdio: "inherit", env: { ...process.env, ...helper.env } },
);
console.log(`built ${outfile}`);
