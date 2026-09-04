// Dev entry: on macOS, builds a per-worktree dev app bundle
// (scripts/lib/devBundle.mts explains why), then spawns
// `electron-forge start` with ELECTRON_OVERRIDE_DIST_PATH pointing at
// it, so the dev process runs from a real, LaunchServices-registered
// .app.
//
// This MUST be a separate wrapper process, not a forge preStart hook:
// node_modules/electron/index.js computes the executable path once at
// first require, and forge's tooling requires it before any hook
// runs, so the override has to be in the environment when the forge
// process starts. The hook variant was tried and silently launched
// the stock Electron.app - the app boots identically, deep links just
// never arrive and every keychain read prompts (verified 2026-08).
//
// `pnpm start --profile <name> [--fresh] [--clone-login]`
// runs the app as a dev profile (scripts/lib/devProfile.mts). The
// other flags go to forge as before.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { errorMessageOf } from "../shared/errors.ts";
import { repoRoot } from "./lib/checkKit.mjs";
import { ensureDevBundle, superviseChild } from "./lib/devBundle.mts";
import {
  applyDevProfileFlags,
  devProfileEnv,
  devProfilePaths,
  parseDevProfileArgs,
} from "./lib/devProfile.mts";

let forgeArgs: string[] = [];
try {
  const args = parseDevProfileArgs(process.argv.slice(2));
  forgeArgs = args.rest;
  if (args.profile === null) {
    if (args.fresh || args.cloneLogin) {
      throw new Error(
        "--fresh and --clone-login apply to a profile: pass --profile <name>",
      );
    }
  } else {
    const profile = devProfilePaths(args.profile);
    applyDevProfileFlags(profile, args);
    Object.assign(process.env, devProfileEnv(profile));
    console.log(
      `[dev-electron] profile ${profile.name}: data dir ${profile.dataDir}`,
    );
  }
} catch (error) {
  console.error(`[dev-electron] ${errorMessageOf(error)}`);
  process.exit(1);
}

// A stale override (a leftover export, a nested dev shell) would both
// poison srcApp resolution above and leak into the child. Ours is set
// fresh below when the bundle builds.
delete process.env.ELECTRON_OVERRIDE_DIST_PATH;

if (process.platform === "darwin") {
  try {
    process.env.ELECTRON_OVERRIDE_DIST_PATH = ensureDevBundle();
  } catch (error) {
    // A broken bundle build should degrade to the unbundled dev of
    // old (dev runs, social sign-in doesn't), not block dev.
    console.warn(
      `[dev-electron] dev app bundle failed, launching unbundled: ${error}`,
    );
  }
}

// Windows cannot exec the extensionless .bin sh shim. Going through
// the shell picks up electron-forge.cmd from the pnpm-provided PATH.
const isWindows = process.platform === "win32";
const child = isWindows
  ? spawn("electron-forge", ["start", ...forgeArgs], {
      cwd: repoRoot,
      stdio: "inherit",
      shell: true,
    })
  : spawn(
      join(repoRoot, "node_modules", ".bin", "electron-forge"),
      ["start", ...forgeArgs],
      { cwd: repoRoot, stdio: "inherit" },
    );
superviseChild(child, "electron-forge");
