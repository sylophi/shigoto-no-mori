// Packages the app for Linux: the host with no shell around it
// (headless/), the node it runs on, node-pty and the binaries it and the
// terminal run, in one folder, tarred as the release's Linux asset in
// out/make/. The folder is what an install keeps under versions/
// (packages/engine/src/linuxInstall.ts). Linux x64 alone, built on it,
// since node-pty's addon is compiled at install (prepare-node-pty.mts).
// SM_FLAVOR makes a test flavor's, as for the app.
//
// Run: node scripts/package-linux.mts
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_BUNDLE,
  HOST_RUNTIME,
  linuxPackageName,
} from "@shigomori/engine/linuxInstall";
import { buildFlavor } from "../shared/packaging/buildFlavor.mts";
import { CLI_DIST_DIR, cliBinaryName } from "../shared/packaging/cliDist.mts";
import {
  CLOUDFLARED_BINARY_NAME,
  CLOUDFLARED_DIST_DIR,
} from "../shared/packaging/cloudflaredDist.mts";
import {
  FILE_SYNC_BINARY_NAME,
  FILE_SYNC_DIST_DIR,
} from "../shared/packaging/fileSyncDist.mts";
import {
  NATIVEFS_BINARY_NAME,
  NATIVEFS_DIST_DIR,
} from "../shared/packaging/nativefsDist.mts";
import {
  NODE_BINARY_NAME,
  NODE_DIST_DIR,
  NODE_LICENSE_NAME,
} from "../shared/packaging/nodeDist.mts";
import {
  NODE_PTY_BUILT_ADDON,
  NODE_PTY_PACKAGE,
} from "../shared/packaging/nodePty.mts";
import { appRoot } from "./lib/appRoot.mts";

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("A Linux package is built on Linux x64.");
}

const flavor = buildFlavor(process.env);
const { version } = JSON.parse(
  readFileSync(join(appRoot, "package.json"), "utf8"),
) as { version: string };
const name = linuxPackageName(flavor, version);

const node = (script: string, ...args: string[]) =>
  execFileSync("node", [`scripts/${script}`, ...args], {
    cwd: appRoot,
    stdio: "inherit",
  });
node("build-file-sync.mts");
node("build-nativefs.mts");
node("build-cli.mts");
node("fetch-cloudflared.mts", "--platform", "linux", "--arch", "x64");
node("fetch-node.mts");
node("build-headless.mts");

const folder = join(appRoot, "out", "linux", name);
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
const ship = (from: string, to: string) =>
  cpSync(join(appRoot, from), join(folder, to), { recursive: true });

ship(join(NODE_DIST_DIR, NODE_BINARY_NAME), HOST_RUNTIME);
ship(join("dist-headless", "host.cjs"), HOST_BUNDLE);
ship(join(CLI_DIST_DIR, cliBinaryName(flavor)), cliBinaryName(flavor));
ship(join(NATIVEFS_DIST_DIR, NATIVEFS_BINARY_NAME), NATIVEFS_BINARY_NAME);
ship(join(FILE_SYNC_DIST_DIR, FILE_SYNC_BINARY_NAME), FILE_SYNC_BINARY_NAME);
ship(
  join(CLOUDFLARED_DIST_DIR, CLOUDFLARED_BINARY_NAME),
  CLOUDFLARED_BINARY_NAME,
);
// node-pty as the host requires it: its manifest, its JS and the addon.
ship(
  join(NODE_PTY_PACKAGE, "package.json"),
  join(NODE_PTY_PACKAGE, "package.json"),
);
ship(join(NODE_PTY_PACKAGE, "lib"), join(NODE_PTY_PACKAGE, "lib"));
ship(NODE_PTY_BUILT_ADDON, NODE_PTY_BUILT_ADDON);
// The notices of what this package ships, and node's own.
node("generate-third-party-licenses.mts", "--out", join(folder, "licenses"));
ship(join(NODE_DIST_DIR, NODE_LICENSE_NAME), join("licenses", "node-LICENSE"));

const tarball = join(appRoot, "out", "make", `${name}.tar.gz`);
mkdirSync(join(appRoot, "out", "make"), { recursive: true });
execFileSync("tar", [
  "-czf",
  tarball,
  "-C",
  join(appRoot, "out", "linux"),
  "--owner=0",
  "--group=0",
  name,
]);
console.log(`packaged ${tarball}`);
