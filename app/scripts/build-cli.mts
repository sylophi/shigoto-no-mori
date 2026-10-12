// Compiles the terminal sm (packages/cli) into a standalone Bun binary.
// The packaged build's flavor (SM_FLAVOR, shared/packaging/buildFlavor.mts),
// or dev; naming and data dir policy are the flavor table's
// (packages/engine/src/flavor.ts).
//   default        -> dist-cli/sm   targets ~/.sm  (bundled with the app)
//   SM_FLAVOR=v3   -> dist-cli/smv3 targets ~/.smv3 (bundled with a v3 build)
//   --dev          -> dist-cli/smd  targets ~/.smd (built by `pnpm dev`)
// The binary finds the darwin helper beside itself, as the app's
// Resources ship them, so the build gets a copy of the one in
// dist-macfs/ (build it first, as dev-cli.mts and install-cli.mts do).
//
// Run: pnpm cli:build [--dev]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFlavor } from "../shared/packaging/buildFlavor.mts";
import { CLI_DIST_DIR, cliBinaryName } from "../shared/packaging/cliDist.mts";
import {
  MACFS_BINARY_NAME,
  MACFS_DIST_DIR,
} from "../shared/packaging/macfsDist.mts";
import { appRoot, repoRoot } from "./lib/appRoot.mts";

const flavor = process.argv.includes("--dev")
  ? "dev"
  : buildFlavor(process.env);

const version =
  flavor === "dev"
    ? "dev"
    : JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version;

const outdir = join(appRoot, CLI_DIST_DIR);
const outfile = join(outdir, cliBinaryName(flavor));

execFileSync(
  "node",
  ["build.mts", outfile, `--flavor=${flavor}`, `--version=${version}`],
  { cwd: join(repoRoot, "packages", "cli"), stdio: "inherit" },
);

const macfs = join(appRoot, MACFS_DIST_DIR, MACFS_BINARY_NAME);
if (existsSync(macfs)) copyFileSync(macfs, join(outdir, MACFS_BINARY_NAME));
console.log(`built ${outfile} (version ${version})`);
