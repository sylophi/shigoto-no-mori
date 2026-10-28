// Fetches the pinned node (shared/packaging/nodeDist.mts) into
// dist-node/: its binary and its license, which a Linux package ships
// (scripts/package-linux.mts). The digest is checked before anything
// is unpacked, and nothing is run.
//
// Run: node scripts/fetch-node.mts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  NODE_ARCHIVE,
  NODE_BINARY_NAME,
  NODE_DIST_DIR,
  NODE_LICENSE_NAME,
  NODE_VERSION,
  nodeDownloadUrl,
} from "../shared/packaging/nodeDist.mts";
import { appRoot } from "./lib/appRoot.mts";

const distDir = join(appRoot, NODE_DIST_DIR);
const stampPath = join(distDir, "stamp");
const stamp = `${NODE_VERSION}\n`;

if (
  existsSync(join(distDir, NODE_BINARY_NAME)) &&
  existsSync(stampPath) &&
  readFileSync(stampPath, "utf8") === stamp
) {
  console.log(`[node] ${NODE_VERSION} already in ${NODE_DIST_DIR}/`);
  process.exit(0);
}

const url = nodeDownloadUrl();
console.log(`[node] fetching ${url}`);
const response = await fetch(url);
if (!response.ok)
  throw new Error(`[node] download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== NODE_ARCHIVE.sha256) {
  throw new Error(
    `[node] sha256 mismatch for ${NODE_ARCHIVE.name}: expected ${NODE_ARCHIVE.sha256}, got ${digest}`,
  );
}

// Unpacked aside and swapped in whole, so a failure keeps the copy
// already there.
const staging = `${distDir}.tmp`;
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const archive = join(staging, NODE_ARCHIVE.name);
writeFileSync(archive, bytes);
const top = NODE_ARCHIVE.name.replace(/\.tar\.gz$/, "");
execFileSync("tar", [
  "-xzf",
  archive,
  "-C",
  staging,
  "--strip-components=1",
  `${top}/bin/${NODE_BINARY_NAME}`,
  `${top}/${NODE_LICENSE_NAME}`,
]);
renameSync(
  join(staging, "bin", NODE_BINARY_NAME),
  join(staging, NODE_BINARY_NAME),
);
rmSync(join(staging, "bin"), { recursive: true });
rmSync(archive);
writeFileSync(join(staging, "stamp"), stamp);
rmSync(distDir, { recursive: true, force: true });
renameSync(staging, distDir);
console.log(
  `[node] ${NODE_VERSION} ready at ${NODE_DIST_DIR}/${NODE_BINARY_NAME}`,
);
