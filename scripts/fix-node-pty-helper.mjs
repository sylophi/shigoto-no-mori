#!/usr/bin/env node
// node-pty starts every PTY child through a small `spawn-helper` binary
// shipped next to its prebuilt addon. The published tarball carries it
// without the executable bit and relies on node-pty's install scripts,
// which this repo disables (pnpm-workspace.yaml: allowBuilds). Without
// the bit every script run fails with "posix_spawnp failed", so restore
// it here as a postinstall step -- for every prebuild present, since a
// package built for the other Mac architecture ships that one's helper.
//
// A missing prebuild for this machine is an error, not a skip: the
// script console can't spawn anything without it, and that is far
// easier to read here than at the first run.

import { chmod, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREBUILDS = join(ROOT, "node_modules", "node-pty", "prebuilds");
const HOST = `${process.platform}-${process.arch}`;

async function makeExecutable(dir) {
  const helper = join(PREBUILDS, dir, "spawn-helper");
  const info = await stat(helper).catch(() => null);
  if (!info) return false;
  if (!(info.mode & 0o111)) {
    await chmod(helper, info.mode | 0o755);
    console.log(`[fix-node-pty-helper] made ${dir}/spawn-helper executable`);
  }
  return true;
}

const dirs = await readdir(PREBUILDS).catch(() => null);
if (dirs !== null) {
  const found = await Promise.all(dirs.map(makeExecutable));
  if (!dirs.some((dir, i) => dir === HOST && found[i])) {
    console.error(
      `[fix-node-pty-helper] node-pty ships no ${HOST} prebuild with a spawn-helper; the script console cannot start processes`,
    );
    process.exit(1);
  }
}
