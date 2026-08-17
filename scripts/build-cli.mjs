// Compiles the sm CLI (a Go module in cli/) into a standalone binary,
// same distribution shape as port-pool. Two flavors, mirroring the
// app's packaged/dev split; naming and root policy come from
// shared/cliDist.mts and are injected into the binary via -ldflags so
// the two languages share one source of truth.
//   default -> dist-cli/sm   targets ~/shigomori     (bundled with the app)
//   --dev   -> dist-cli/smd  targets ~/shigomori-dev (built by `pnpm dev`)
//
// Run: pnpm cli:build [--dev]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_BUNDLE_ID,
  UPDATE_FEED_REPO,
  CLI_DIST_DIR,
  cliAliasName,
  cliBinaryName,
  cliRootDirName,
} from "../shared/cliDist.mts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flavor = process.argv.includes("--dev") ? "dev" : "prod";

const version =
  flavor === "dev"
    ? "dev"
    : JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

const outfile = join(repoRoot, CLI_DIST_DIR, cliBinaryName(flavor));

const ldflags = [
  `-X main.version=${version}`,
  `-X main.flavor=${flavor}`,
  `-X main.rootDirName=${cliRootDirName(flavor)}`,
  `-X main.binaryName=${cliBinaryName(flavor)}`,
  `-X main.aliasName=${cliAliasName(flavor)}`,
  `-X main.appBundleID=${APP_BUNDLE_ID}`,
  `-X main.updateFeedRepo=${UPDATE_FEED_REPO}`,
  "-s",
  "-w",
].join(" ");

execFileSync(
  "go",
  ["build", "-C", "cli", "-trimpath", "-ldflags", ldflags, "-o", outfile, "."],
  { cwd: repoRoot, stdio: "inherit" },
);
console.log(`built ${outfile} (version ${version})`);
