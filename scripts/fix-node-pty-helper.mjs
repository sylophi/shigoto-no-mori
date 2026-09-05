#!/usr/bin/env node
// node-pty starts every PTY child through a small `spawn-helper` binary
// shipped next to its prebuilt addon. The published tarball carries it
// without the executable bit and relies on node-pty's install scripts,
// which this repo disables (pnpm-workspace.yaml: allowBuilds). Without
// the bit every script run fails with "posix_spawnp failed", so restore
// it here as a postinstall step -- for every prebuild present, since a
// package built for the other Mac architecture ships that one's helper.
//
// On a Mac, a missing prebuild for this machine is an error, not a
// skip: the script console can't spawn anything without it, and that
// is far easier to read here than at the first run. Elsewhere (a Linux
// CI box running lint) node-pty ships nothing and the app isn't built,
// so it is only a note.

import { chmod, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NODE_PTY_PREBUILDS,
  NODE_PTY_SPAWN_HELPER,
  nodePtyPrebuildDir,
} from "../shared/nodePty.mts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// True when a helper was found (and is now executable).
async function makeExecutable(dir) {
  const helper = join(ROOT, dir, NODE_PTY_SPAWN_HELPER);
  const info = await stat(helper).catch(() => null);
  if (!info) return false;
  if (!(info.mode & 0o111)) {
    await chmod(helper, info.mode | 0o755);
    console.log(
      `[fix-node-pty-helper] made ${dir}/${NODE_PTY_SPAWN_HELPER} executable`,
    );
  }
  return true;
}

const prebuilds = join(ROOT, NODE_PTY_PREBUILDS);
const dirs = await readdir(prebuilds).catch(() => []);
await Promise.all(
  dirs.map((dir) => makeExecutable(join(NODE_PTY_PREBUILDS, dir))),
);

const host = nodePtyPrebuildDir(process.platform, process.arch);
if (!(await makeExecutable(host))) {
  const message = `[fix-node-pty-helper] no node-pty prebuild for this machine at ${host}; the script console cannot start processes`;
  if (process.platform === "darwin") {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
}
