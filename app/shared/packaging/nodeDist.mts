// The node a Linux install runs its host with (headless/), shipped in
// each version's folder, so the host runs on the node it was built and
// tested for and nothing is asked of the machine's. The 24 line, as the
// app's Electron carries. scripts/fetch-node.mts fetches the official
// build pinned here: one version and the sha256 of its archive,
// committed, so a bump is a reviewed diff to this file and the fetch
// refuses anything else.
//
// .mts with no imports, loadable by plain `node scripts/*.mts`.
export const NODE_VERSION = "24.22.1";

// Repo-relative directory the binary and its license land in
// (gitignored).
export const NODE_DIST_DIR = "dist-node";
export const NODE_BINARY_NAME = "node";
export const NODE_LICENSE_NAME = "LICENSE";

export const NODE_ARCHIVE = {
  name: `node-v${NODE_VERSION}-linux-x64.tar.gz`,
  sha256: "eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c",
};

export const nodeDownloadUrl = () =>
  `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE.name}`;
