#!/usr/bin/env node
// node-pty's install scripts, which this repo disables
// (pnpm-workspace.yaml: allowBuilds), as a postinstall step instead.
//
// On a Mac node-pty ships prebuilt addons, and starts every PTY child
// through a small `spawn-helper` binary beside each, which the tarball
// carries without the executable bit. Without the bit every script run
// fails with "posix_spawnp failed", so it is restored for every prebuild
// present, since a package built for the other Mac architecture ships
// that one's helper. A missing prebuild for this machine is an error,
// not a skip: the script console can't spawn anything without it, and
// that is far easier to read here than at the first run.
//
// On Linux node-pty ships no prebuild (and needs no helper), so the
// addon is compiled into its build/ folder, against the headers of the
// node running this when it has them (an official build does). It is a
// Node-API addon, so the one build loads under node and Electron alike.
// That takes python3, make and a C++ compiler.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  NODE_PTY_BUILT_ADDON,
  NODE_PTY_PACKAGE,
  NODE_PTY_PREBUILDS,
  NODE_PTY_SPAWN_HELPER,
  nodePtyPrebuildDir,
} from "../shared/packaging/nodePty.mts";

const ROOT = resolve(import.meta.dirname, "..");

// True when a helper was found (and is now executable).
async function makeExecutable(dir: string): Promise<boolean> {
  const helper = join(ROOT, dir, NODE_PTY_SPAWN_HELPER);
  const info = await stat(helper).catch(() => null);
  if (!info) return false;
  if (!(info.mode & 0o111)) {
    await chmod(helper, info.mode | 0o755);
    console.log(
      `[prepare-node-pty] made ${dir}/${NODE_PTY_SPAWN_HELPER} executable`,
    );
  }
  return true;
}

if (process.platform === "darwin") {
  const prebuilds = join(ROOT, NODE_PTY_PREBUILDS);
  const dirs = await readdir(prebuilds).catch(() => []);
  await Promise.all(
    dirs.map((dir) => makeExecutable(join(NODE_PTY_PREBUILDS, dir))),
  );
  const host = nodePtyPrebuildDir(process.platform, process.arch);
  if (!(await makeExecutable(host))) {
    console.error(
      `[prepare-node-pty] no node-pty prebuild for this machine at ${host}; the script console cannot start processes`,
    );
    process.exit(1);
  }
} else if (process.platform === "linux") {
  if (!existsSync(join(ROOT, NODE_PTY_BUILT_ADDON))) {
    const nodeDir = dirname(dirname(process.execPath));
    const headers = existsSync(join(nodeDir, "include", "node", "node_api.h"))
      ? [`--nodedir=${nodeDir}`]
      : [];
    // node-gyp talks at length whatever its log level, so what it said
    // is shown only when the build fails.
    try {
      execFileSync(
        join(ROOT, "node_modules", ".bin", "node-gyp"),
        ["rebuild", ...headers],
        { cwd: join(ROOT, NODE_PTY_PACKAGE), stdio: "pipe" },
      );
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
      process.stderr.write(`${stdout ?? ""}${stderr ?? ""}`);
      console.error(
        "[prepare-node-pty] could not build node-pty's addon (it needs python3, make and a C++ compiler)",
      );
      process.exit(1);
    }
    console.log(`[prepare-node-pty] built ${NODE_PTY_BUILT_ADDON}`);
  }
} else {
  console.warn(
    `[prepare-node-pty] node-pty has nothing for ${process.platform}; the script console cannot start processes`,
  );
}
