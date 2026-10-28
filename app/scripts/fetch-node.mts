// Fetches the pinned node (shared/packaging/nodeDist.mts) into
// dist-node/: its binary and its license, which a Linux package ships
// (scripts/package-linux.mts).
//
// Run: node scripts/fetch-node.mts
import { execFileSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
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
import { fetchPinned } from "./lib/fetchPinned.mts";

const kept = await fetchPinned({
  label: "node",
  distDir: join(appRoot, NODE_DIST_DIR),
  binaryName: NODE_BINARY_NAME,
  stamp: `${NODE_VERSION}\n`,
  url: nodeDownloadUrl(),
  name: NODE_ARCHIVE.name,
  sha256: NODE_ARCHIVE.sha256,
  unpack: (bytes, staging) => {
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
  },
});
console.log(
  kept
    ? `[node] ${NODE_VERSION} already in ${NODE_DIST_DIR}/`
    : `[node] ${NODE_VERSION} ready at ${NODE_DIST_DIR}/${NODE_BINARY_NAME}`,
);
