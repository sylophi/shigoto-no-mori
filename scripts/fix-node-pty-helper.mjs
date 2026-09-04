#!/usr/bin/env node
// node-pty starts every PTY child through a small `spawn-helper` binary
// shipped next to its prebuilt addon. The published tarball carries it
// without the executable bit and relies on node-pty's install scripts,
// which this repo disables (pnpm-workspace.yaml: allowBuilds). Without
// the bit every script run fails with "posix_spawnp failed", so restore
// it here as a postinstall step.
//
// Idempotent, and a no-op on platforms whose prebuild has no helper.

import { chmod, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREBUILDS = join(ROOT, "node_modules", "node-pty", "prebuilds");

async function listPrebuildDirs() {
  try {
    return await readdir(PREBUILDS);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function makeExecutable(dir) {
  const helper = join(PREBUILDS, dir, "spawn-helper");
  let info;
  try {
    info = await stat(helper);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (info.mode & 0o111) return;
  await chmod(helper, info.mode | 0o755);
  console.log(`[fix-node-pty-helper] made ${dir}/spawn-helper executable`);
}

await Promise.all((await listPrebuildDirs()).map(makeExecutable));
