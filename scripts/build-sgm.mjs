// Compiles the sgm CLI (a Go module in cli/) into a standalone binary,
// same distribution shape as port-pool. Two flavors, mirroring the
// app's packaged/dev split; naming and root policy come from
// shared/sgmDist.mts and are injected into the binary via -ldflags so
// the two languages share one source of truth.
//   default -> dist-cli/sgm   targets ~/shigomori     (bundled with the app)
//   --dev   -> dist-cli/sgmd  targets ~/shigomori-dev (built by `pnpm dev`)
// The CLI is not supported on Windows and is never built for it.
//
// Run: pnpm cli:build [--dev]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SGM_DIST_DIR,
  sgmBinaryName,
  sgmRootDirName,
} from "../shared/sgmDist.mts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flavor = process.argv.includes("--dev") ? "dev" : "prod";

const version =
  flavor === "dev"
    ? "dev"
    : JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

if (
  process.env.GOOS === "windows" ||
  (process.env.GOOS === undefined && process.platform === "win32")
) {
  console.error("[build-sgm] the CLI is not supported on Windows");
  process.exit(1);
}
const outfile = join(repoRoot, SGM_DIST_DIR, sgmBinaryName(flavor));

const ldflags = [
  `-X main.version=${version}`,
  `-X main.flavor=${flavor}`,
  `-X main.rootDirName=${sgmRootDirName(flavor)}`,
  `-X main.binaryName=${sgmBinaryName(flavor)}`,
  "-s",
  "-w",
].join(" ");

execFileSync(
  "go",
  ["build", "-C", "cli", "-trimpath", "-ldflags", ldflags, "-o", outfile, "."],
  { cwd: repoRoot, stdio: "inherit" },
);
console.log(`built ${outfile} (version ${version})`);
